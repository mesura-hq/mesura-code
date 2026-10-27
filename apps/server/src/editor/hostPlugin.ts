/**
 * The Lua the host forces on every embedded Neovim, as a string so `vp pack` needs no asset rule.
 * The launch sources it with `-c`: lazy.nvim replaces `runtimepath` while `init.lua` runs, so a
 * `plugin/` file is never sourced. Plugins set window options later, so autocommands re-apply them.
 */

/**
 * The options that keep grid column N equal to buffer column N, which the virtual-text
 * classification needs: a gutter shifts every column, `list` paints over spaces and
 * `conceallevel` changes widths. `vscode-neovim` forces the same set.
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
  -- A closed fold is one row standing for many lines, a 'statuscolumn' draws a
  -- margin even with numbers off, and a 'winbar' takes the first row: each one
  -- breaks "row N shows line topline + N", which the classification reads by.
  vim.wo.foldenable = false
  vim.wo.statuscolumn = ""
  vim.wo.winbar = ""
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
vim.opt.foldenable = false
vim.opt.statuscolumn = ""
vim.opt.winbar = ""
vim.opt.scrolloff = 0
vim.opt.sidescrolloff = 0

-- Chrome the host already draws, or does not want.
vim.opt.laststatus = 0
vim.opt.showmode = false
vim.opt.ruler = false
vim.opt.showcmd = false
vim.opt.cmdheight = 1

-- Inlay hints are inline virtual text: cells that are in no buffer line, so
-- every character after one is read a column off. Off globally, and again per
-- buffer when a server attaches, because a configuration usually turns them on
-- in its own LspAttach.
pcall(vim.lsp.inlay_hint.enable, false)
vim.api.nvim_create_autocmd("LspAttach", {
  group = group,
  callback = function(event)
    vim.schedule(function()
      pcall(vim.lsp.inlay_hint.enable, false, { bufnr = event.buf })
    end)
  end,
})

--- Syntax and treesitter are the editor's job here. Left on, every cell
--- carries a highlight and the decoration stream becomes the whole viewport on
--- every keystroke, for colours the editor is already drawing itself.
---
--- Only the highlighter is stopped, not the parser, so plugins that query the
--- syntax tree (flash's treesitter mode is the one that matters here) keep
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

--- The mirror follows only the buffer the host opened, and only because the
--- host told it to.
---
--- There was a 'BufEnter' announcement here that told the host whenever the
--- current buffer changed. It is gone, and deliberately. Neovim announces a
--- plugin's picker, git status, prompt or terminal exactly the way it
--- announces a file, so the host followed plugins into their own buffers,
--- sent their contents to the client as the open file, and the save that
--- followed wrote a plugin's window over the source. Marking the host's own
--- buffers narrowed that, but left a second fault with no self-healing path:
--- a switch between two host buffers moved the mirror and told the manager
--- nothing, so 'currentPath' named one file while the mirror carried another.
---
--- The dashboard this was written for needs no announcement either: the host
--- opens the file into a buffer it owns, and 'Manager.open' follows the buffer
--- 'mesura.open' answers with. That is the only switch the host ever makes,
--- and nothing else may move the mirror.

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

--- The buffer the host mirrors. Set by the host whenever it follows one.
mesura.attached = 0

--- The cursor, the mode, the selection anchor and flash's state, as the host
--- reads them. Called by the host's own read and by the push below, so both
--- answer the same thing.
---
--- Columns leave here in UTF-16 units, which is what the wire and Monaco count
--- in. Neovim counts bytes: on a line holding an accent or an emoji the raw
--- byte column put the caret several characters to the right, and past the
--- end of the line Monaco silently clamped it there. The visual anchor comes
--- with the mode, because getpos("v") answers wherever the cursor is when no
--- selection is running, so the mode is what says whether it means anything.
local function utf16_col(line, byte)
  local text = vim.fn.getline(line)
  return vim.str_utfindex(text, "utf-16", math.min(byte, #text), false) + 1
end

--- Whether flash is waiting for a label in the attached buffer.
function mesura.flash_jumping(attached)
  if attached == 0 or not vim.api.nvim_buf_is_valid(attached) then return false end
  -- flash draws in its own namespace. Looked up until flash, which loads
  -- lazily, has created it, and cached after: this runs on every key.
  mesura.flash_namespace = mesura.flash_namespace or vim.api.nvim_get_namespaces().flash
  local flash = mesura.flash_namespace
  if flash == nil then return false end
  -- A label is the one mark with virtual text; the backdrop and the
  -- matches are plain highlights. Those stay up after an f motion, for ;
  -- to repeat it, when no label is waiting.
  local marks = vim.api.nvim_buf_get_extmarks(attached, flash, 0, -1, { details = true })
  for _, mark in ipairs(marks) do
    if mark[4].virt_text ~= nil then return true end
  end
  return false
end

--- Whether Neovim, in plain normal mode and not blocked, still waits for keys
--- a command asked for, and whether flash waits for a label. Read after a key
--- batch to decide where Escape goes; see modeAfterKeys in Manager.ts.
---
--- state() holds S while a command is unfinished: flash's f, which waits in
--- getcharstr() with requests still served and the mode at n; a count. Also m
--- halfway a mapping, o an operator, a insert completion, w a blocking wait.
--- Empty at rest.
function mesura.escape_state(attached)
  return {
    waiting = vim.fn.state():find("[Smoaw]") ~= nil,
    jumping = mesura.flash_jumping(attached),
  }
end

function mesura.cursor_state(attached)
  local position = vim.api.nvim_win_get_cursor(0)
  local mode = vim.api.nvim_get_mode().mode
  local anchor = nil
  if mode:sub(1, 1) == "v" or mode:sub(1, 1) == "V" or mode:byte(1) == 22 then
    local other = vim.fn.getpos("v")
    anchor = { line = other[2], col = utf16_col(other[2], other[3] - 1) }
  end
  local tabstop = 8
  if attached ~= 0 and vim.api.nvim_buf_is_valid(attached) then
    tabstop = vim.bo[attached].tabstop
  end
  local jumping = mesura.flash_jumping(attached)
  return {
    line = position[1],
    col = utf16_col(position[1], position[2]),
    mode = mode,
    anchor = anchor,
    window = vim.api.nvim_get_current_win(),
    tabstop = tabstop,
    jumping = jumping,
    -- How far the window is scrolled sideways. The host's classification
    -- reads every cell against the buffer from this column on.
    leftcol = vim.fn.winsaveview().leftcol,
  }
end

--- Pushes the cursor to the host whenever it moves or the mode changes.
---
--- Neovim runs these autocommands after it handles the key and before it
--- redraws, so the push reaches the host ahead of the frame that draws the
--- key, and the host sends the text and the caret together without asking.
--- They do not fire while typeahead is pending, so a batch of keys pushes once,
--- after its last key. Whatever moves the cursor without them (flash waiting
--- for a label) the host still reads after the frame. 'WinScrolled' carries
--- a sideways scroll that left the cursor where it was (zh, zl), because the
--- push is also where the host learns 'leftcol'.
vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "ModeChanged", "WinScrolled" }, {
  group = group,
  callback = function()
    local channel = vim.g.mesura_channel
    if type(channel) == "number" then
      pcall(vim.rpcnotify, channel, "mesura:cursor", mesura.cursor_state(mesura.attached))
    end
  end,
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

/**
 * Applies a batch of text edits as one undo step: one `nvim_exec_lua`, because each RPC call is
 * its own undo block. It sorts the edits itself and applies them from the end backwards, since
 * every position describes the text before any edit ran. The conformance harness drives it.
 */
export const APPLY_EDITS_LUA = `local buffer, edits = ...
-- Columns arrive in UTF-16 units, as Monaco counts them, and nvim_buf_set_text
-- takes bytes. All of them are converted against the text before any edit
-- runs, because that is the text every edit's positions describe.
local function byte_col(line, utf16)
  local text = vim.api.nvim_buf_get_lines(buffer, line, line + 1, false)[1] or ""
  return vim.str_byteindex(text, "utf-16", utf16, false)
end
for _, edit in ipairs(edits) do
  edit[2] = byte_col(edit[1], edit[2])
  edit[4] = byte_col(edit[3], edit[4])
end
table.sort(edits, function(left, right)
  if left[1] ~= right[1] then return left[1] < right[1] end
  return left[2] < right[2]
end)
for index = #edits, 1, -1 do
  local edit = edits[index]
  vim.api.nvim_buf_set_text(buffer, edit[1], edit[2], edit[3], edit[4], edit[5])
end`;

/**
 * Puts the cursor where the client put it, in the window showing the file. Not window `0`:
 * a plugin often owns the current window. A buffer with no window has nothing to move.
 */
export const SET_CURSOR_LUA = `local buffer, line, col = ...
local window = vim.fn.bufwinid(buffer)
if window == -1 then
  return
end
local last = vim.api.nvim_buf_line_count(buffer)
local target = math.max(1, math.min(line, last))
-- 'col' is a UTF-16 offset, as Monaco counts; the window wants bytes.
local text = vim.api.nvim_buf_get_lines(buffer, target - 1, target, false)[1] or ""
vim.api.nvim_win_set_cursor(window, { target, vim.str_byteindex(text, "utf-16", col, false) })`;

/**
 * Puts Neovim's window where the client's is. Neovim snaps back a view that hides the cursor,
 * so a pointer scroll moves the cursor into view, as Vim's mouse wheel does. With `keep_cursor`
 * (a key scrolled Neovim) the cursor stays, because a stale request would undo the keys.
 */
export const SET_VIEWPORT_LUA = `local buffer, topline, rows, keep_cursor = ...
local window = vim.fn.bufwinid(buffer)
if window == -1 then
  return
end
local last = vim.api.nvim_buf_line_count(buffer)
local top = math.max(1, math.min(topline, last))
local bottom = math.max(top, math.min(last, top + rows - 1))
vim.api.nvim_win_call(window, function()
  local view = vim.fn.winsaveview()
  if keep_cursor then
    if view.lnum < top then
      top = view.lnum
    elseif view.lnum > bottom then
      top = math.max(1, view.lnum - rows + 1)
    end
    vim.fn.winrestview({ topline = top })
    return
  end
  local lnum = math.min(math.max(view.lnum, top), bottom)
  vim.fn.winrestview({ topline = top, lnum = lnum, col = view.col })
end)`;

/**
 * Scrolls the window showing the file back to its first column.
 *
 * Neovim keeps the cursor in view on the next redraw, so asking for column 0
 * with the cursor further right than the grid is wide only scrolls as far
 * back as Neovim allows.
 */
export const RESET_LEFT_COLUMN_LUA = `local buffer = ...
local window = vim.fn.bufwinid(buffer)
if window == -1 then
  return
end
vim.api.nvim_win_call(window, function()
  vim.fn.winrestview({ leftcol = 0 })
end)`;
