/**
 * The Lua the host forces on every embedded Neovim.
 *
 * Kept as a string rather than a `.lua` asset so the desktop bundle needs no
 * asset rule: the server is packed with `vp pack`, and a file read at runtime
 * from beside the bundle is one more thing that can be absent in a packaged app.
 *
 * It is written into a scratch runtime path and sourced with `-c`, not left
 * for Neovim to find under `plugin/` or `after/plugin/`. That is not a
 * preference — the runtime path is not a place a host can rely on:
 * **lazy.nvim replaces `runtimepath` wholesale** while `init.lua` runs, so a
 * directory put there with `--cmd 'set runtimepath^=…'` is gone before Neovim
 * scans for plugin files, and `after/plugin/mesura_host.lua` is never sourced.
 * Measured, not assumed: with the developer's configuration loaded, the
 * runtime path contained the host's directory at `--cmd` time and did not
 * contain it afterwards, and `getscriptinfo()` listed no host script at all.
 * Every forced option quietly did nothing.
 *
 * `-c` is argv rather than state, so no configuration can take it away. It
 * runs after every startup plugin has been sourced and before `VimEnter`.
 *
 * Setting an option first is not the same as owning it. The developer's own
 * settings load before this, plugins such as statuscol set window options per
 * window afterwards, and lazy-loaded plugins arrive later still — so the
 * options are also re-applied from autocommands rather than assigned once.
 */

/**
 * The options the host must own, and why each one.
 *
 * The first group is not cosmetic. Every one of these keeps grid column N
 * equal to buffer column N, which is the assumption the whole virtual-text
 * classification rests on. With line numbers left on, a flash jump produced
 * 132 phantom labels in the prototype, because every character on the line
 * differed from the buffer character it was compared against. `list` and
 * `conceallevel` break the same equality from the other direction: `list`
 * paints a character where the buffer holds a space, and `conceallevel`
 * replaces buffer text with something of a different width.
 * `vscode-neovim` forces the same set for the same reason.
 */
export const HOST_PLUGIN_LUA = `
-- Written by Mesura Code. The host draws the gutter, the status line and the
-- selection; Neovim draws the text. Anything Neovim paints in the margin, or
-- in place of a buffer character, shifts every column and is read as text that
-- is not there.

local group = vim.api.nvim_create_augroup("MesuraHost", { clear = true })

--- Options the host owns, applied to one window.
---
--- Window-local rather than global, because a plugin that sets them per window
--- would otherwise win on every window it touches.
local function apply_window_options()
  vim.wo.number = false
  vim.wo.relativenumber = false
  vim.wo.signcolumn = "no"
  vim.wo.foldcolumn = "0"
  vim.wo.numberwidth = 1
  vim.wo.wrap = false
  vim.wo.cursorline = false
  vim.wo.cursorcolumn = false
  vim.wo.colorcolumn = ""
  -- 'list' draws listchars where the buffer holds a space or a tab.
  vim.wo.list = false
  -- 'conceallevel' hides buffer text behind something narrower.
  vim.wo.conceallevel = 0
  -- The host scrolls. With a scroll offset Neovim drags the viewport of its
  -- own accord and the two fight over the top line.
  vim.wo.scrolloff = 0
  vim.wo.sidescrolloff = 0
end

-- The same values as globals, so a window opened before an autocommand runs
-- already starts correct rather than being corrected a frame later.
vim.opt.number = false
vim.opt.relativenumber = false
vim.opt.signcolumn = "no"
vim.opt.foldcolumn = "0"
vim.opt.numberwidth = 1
vim.opt.wrap = false
vim.opt.cursorline = false
vim.opt.cursorcolumn = false
vim.opt.colorcolumn = ""
vim.opt.list = false
vim.opt.conceallevel = 0
vim.opt.scrolloff = 0
vim.opt.sidescrolloff = 0

-- Chrome the host already draws, or does not want.
vim.opt.laststatus = 0
vim.opt.showmode = false
vim.opt.ruler = false
vim.opt.showcmd = false
vim.opt.cmdheight = 1

--- Syntax and treesitter are the editor's job here. Left on, every cell
--- carries a highlight and the decoration stream becomes the whole viewport on
--- every keystroke, for colours the editor is already drawing itself.
---
--- Only the highlighter is stopped, not the parser, so plugins that query the
--- syntax tree — flash's treesitter mode is the one that matters here — keep
--- working.
local function stop_highlighting(buf)
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  pcall(vim.treesitter.stop, buf)
  pcall(function()
    vim.bo[buf].syntax = "off"
  end)
end

vim.opt.syntax = "off"

vim.api.nvim_create_autocmd({ "BufWinEnter", "BufEnter", "WinNew", "WinEnter" }, {
  group = group,
  callback = apply_window_options,
})

-- Once more when startup is over. A plugin whose own 'after/plugin' file is
-- sourced behind this one gets the last word at startup, and no window or
-- buffer event necessarily follows it.
vim.api.nvim_create_autocmd("VimEnter", {
  group = group,
  callback = apply_window_options,
})

vim.api.nvim_create_autocmd({ "FileType", "BufWinEnter" }, {
  group = group,
  callback = function(event)
    stop_highlighting(event.buf)
    -- Again on the next tick. Autocommands on one event fire in the order they
    -- were registered, and a plugin lazy-loaded on 'FileType' registers its
    -- own after this file has run, so it would start the highlighter back up
    -- immediately after this callback returned. Scheduling puts the last word
    -- here regardless of registration order.
    vim.schedule(function()
      stop_highlighting(event.buf)
    end)
  end,
})

--- Tells the host which buffer is current.
---
--- The host attaches to a buffer when it connects, and under a real
--- configuration that is very often not the buffer the developer will edit:
--- the developer's own configuration opens a dashboard at startup, on a
--- scratch buffer that is not even modifiable. Without this the mirror stays
--- on the dashboard and reads empty for the rest of the session.
---
--- The channel number arrives as \`vim.g.mesura_channel\`, which the host sets
--- once it knows its own channel. Until then this stays quiet rather than
--- guessing a channel and writing to somebody else's.
local function announce_buffer()
  local channel = vim.g.mesura_channel
  if type(channel) ~= "number" then
    return
  end
  pcall(vim.rpcnotify, channel, "mesura_buffer_changed", vim.api.nvim_get_current_buf())
end

vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
  group = group,
  callback = announce_buffer,
})

apply_window_options()
stop_highlighting(vim.api.nvim_get_current_buf())
`;

/**
 * The file name the plugin is written under, inside the scratch runtime path.
 *
 * Not under `plugin/` or `after/plugin/`: nothing sources it by position, the
 * launch names it directly. See the note at the top of this file.
 */
export const HOST_PLUGIN_RELATIVE_PATH = "mesura_host.lua";
