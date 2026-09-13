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
  local buffer = vim.api.nvim_get_current_buf()
  -- Only a buffer the host opened. Every other buffer that enters a window
  -- belongs to a plugin — a picker, a git status, a prompt, a terminal — and
  -- the mirror must not follow it anywhere.
  --
  -- This destroyed a file before it was here. The host followed Neovim into
  -- whatever buffer a mapping opened, sent that buffer's lines to the client
  -- as though they were the file's, the panel replaced the editor's contents
  -- with them, and the save that followed wrote a plugin's UI over the source.
  -- Reproduced: '<C-f>' in the developer's configuration left a one-line
  -- buffer reading a single emoji, and the file on disk became that emoji.
  --
  -- Marked when the host creates it rather than inferred from 'buftype' or
  -- the name, because both are things a plugin is free to choose and this is
  -- the one question being asked: did we open this?
  if vim.b[buffer].mesura_file == nil then
    return
  end
  pcall(vim.rpcnotify, channel, "mesura_buffer_changed", buffer)
end

vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
  group = group,
  callback = announce_buffer,
})

--- The buffers the host opens, keyed by the file they stand for.
---
--- Neovim never reads or writes the file. The host holds the text, hands it
--- over here, and takes it back through 'nvim_buf_lines_event'; the name is
--- set so filetype detection, the developer's ftplugins and flash's parser all
--- see the file they expect. 'buftype = 'acwrite'' is what makes that
--- consistent: it tells Neovim this buffer is written by somebody else, so
--- ':w' asks rather than writes.
local mesura = {}
_G.mesura = mesura

--- Opens 'abs_path' in the window, with 'lines' as its contents.
---
--- Reuses the buffer for that path when there is one, so moving between two
--- files and back keeps each one's undo history, marks and cursor.
--- Finds the buffer whose name is exactly 'abs_path', or nil.
---
--- Not 'vim.fn.bufnr(abs_path)': that treats its argument as a Vim pattern
--- whenever no buffer matches exactly, which is always true the first time a
--- path is opened. A path can then match some other open buffer whose name
--- happens to satisfy it, and the developer is handed the wrong file under the
--- right name. Comparing names is unambiguous and costs one pass over a list
--- that holds at most a few dozen entries.
local function buffer_named(abs_path)
  for _, buffer in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_valid(buffer) and vim.api.nvim_buf_get_name(buffer) == abs_path then
      return buffer
    end
  end
  return nil
end

function mesura.open(abs_path, lines)
  local buffer = buffer_named(abs_path)
  if buffer == nil then
    buffer = vim.api.nvim_create_buf(true, false)
    vim.api.nvim_buf_set_name(buffer, abs_path)
    vim.bo[buffer].buftype = "acwrite"
    vim.bo[buffer].swapfile = false
    vim.bo[buffer].undofile = false
    -- What 'announce_buffer' above tests. It is the host's own mark, so no
    -- plugin's buffer can carry it by accident.
    vim.b[buffer].mesura_file = abs_path

    -- ':w' is a request, never a write. The host owns the file and saves it
    -- the way the editor's own autosave does, so one path writes it and one
    -- set of rules decides when.
    vim.api.nvim_create_autocmd("BufWriteCmd", {
      buffer = buffer,
      callback = function()
        vim.bo[buffer].modified = false
        local channel = vim.g.mesura_channel
        if type(channel) == "number" then
          pcall(vim.rpcnotify, channel, "mesura:write", abs_path)
        end
      end,
    })
  end

  -- Replaced only when it differs. Setting identical lines still resets undo
  -- and moves every mark, which would throw away the developer's history every
  -- time they came back to a file they had not changed.
  local current = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
  local same = #current == #lines
  if same then
    for index = 1, #current do
      if current[index] ~= lines[index] then
        same = false
        break
      end
    end
  end
  if not same then
    vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
  end

  vim.bo[buffer].modified = false
  vim.api.nvim_win_set_buf(0, buffer)

  local filetype = vim.filetype.match({ filename = abs_path, buf = buffer })
  if filetype ~= nil then
    vim.bo[buffer].filetype = filetype
  end

  apply_window_options()
  stop_highlighting(buffer)
  return buffer
end

--- Closes the buffer for 'abs_path', if the host still has one.
function mesura.close(abs_path)
  local buffer = buffer_named(abs_path)
  if buffer ~= nil then
    pcall(vim.api.nvim_buf_delete, buffer, { force = true })
  end
end

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

/**
 * Applies a batch of text edits as one undo step.
 *
 * Sent as one `nvim_exec_lua` rather than one RPC per edit, because a separate
 * call is a separate undo block: an agent's write would then take several `u`
 * to take back, and the developer would undo half of somebody else's change
 * with no way of knowing there was more. Measured, not assumed — two
 * `nvim_buf_set_text` calls then one `u` left the second edit in place.
 *
 * The edits are sorted here rather than trusted from the caller. They have to
 * be applied from the end of the buffer backwards, because every edit's
 * positions describe the text as it was before any of them ran; applying an
 * earlier one first moves the later one's target. An earlier version relied on
 * the caller passing them in order and corrupted the text silently when it did
 * not — the undo step stayed single, which is what made it hard to see.
 *
 * Exported because the conformance harness drives this exact string. A test
 * with its own copy of the Lua proves the copy works.
 */
export const APPLY_EDITS_LUA = `local edits = ...
table.sort(edits, function(left, right)
  if left[1] ~= right[1] then return left[1] < right[1] end
  return left[2] < right[2]
end)
for index = #edits, 1, -1 do
  local edit = edits[index]
  vim.api.nvim_buf_set_text(0, edit[1], edit[2], edit[3], edit[4], edit[5])
end`;

/**
 * Puts Neovim's window where the client's window is.
 *
 * `winrestview({ topline })` on its own does not hold. Neovim will not keep a
 * window that hides the cursor, so the moment the call returns the view snaps
 * back — measured: topline reads as the requested value from inside the same
 * Lua call and as the old one on the very next round trip, with no key sent.
 * That is exactly the case this exists for, a wheel scroll with the cursor
 * left where it was, so setting topline alone does nothing at all.
 *
 * The cursor therefore moves into the window, and only when it would otherwise
 * be outside it. That is what Vim's own mouse wheel does, and it is the
 * behaviour a developer who chose modal editing already has in their editor.
 */
export const SET_VIEWPORT_LUA = `local topline, rows = ...
local last = vim.api.nvim_buf_line_count(0)
local top = math.max(1, math.min(topline, last))
local bottom = math.max(top, math.min(last, top + rows - 1))
local view = vim.fn.winsaveview()
local lnum = math.min(math.max(view.lnum, top), bottom)
vim.fn.winrestview({ topline = top, lnum = lnum, col = view.col })`;
