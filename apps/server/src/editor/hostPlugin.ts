/**
 * The Lua the host forces on every embedded Neovim.
 *
 * Kept as a string rather than a `.lua` asset so the desktop bundle needs no
 * asset rule: the server is packed with `vp pack`, and a file read at runtime
 * from beside the bundle is one more thing that can be absent in a packaged app.
 *
 * It is written into a scratch runtime path as `plugin/mesura_host.lua`, which
 * Neovim sources after the user's configuration. That ordering is the point —
 * the developer's own settings load first and these then overrule the handful
 * that would break the host's reading of the screen.
 */

/**
 * The options the host must own, and why each one.
 *
 * The gutter group is not cosmetic. Every one of these keeps grid column N
 * equal to buffer column N, which is the assumption the whole virtual-text
 * classification rests on. With line numbers left on, a flash jump produced 132
 * phantom labels in the prototype, because every character on the line differed
 * from the buffer character it was compared against. `vscode-neovim` forces the
 * same set for the same reason.
 */
export const HOST_PLUGIN_LUA = `
-- Written by Mesura Code. The host draws the gutter, the status line and the
-- selection; Neovim draws the text. Anything Neovim paints in the margin shifts
-- every column and is read as text that is not there.
vim.opt.number = false
vim.opt.relativenumber = false
vim.opt.signcolumn = "no"
vim.opt.foldcolumn = "0"
vim.opt.numberwidth = 1
vim.opt.wrap = false

-- The host scrolls. With a scroll offset Neovim drags the viewport of its own
-- accord and the two fight over the top line.
vim.opt.scrolloff = 0
vim.opt.sidescrolloff = 0

-- Chrome the host already draws, or does not want.
vim.opt.laststatus = 0
vim.opt.showmode = false
vim.opt.ruler = false
vim.opt.showcmd = false
vim.opt.cmdheight = 1

-- Syntax and treesitter are Monaco's job here. Left on, every cell carries a
-- highlight and the decoration stream becomes the whole viewport on every
-- keystroke, for colours the editor is already drawing itself.
vim.opt.syntax = "off"
pcall(function()
  vim.treesitter.stop()
end)
vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
  group = vim.api.nvim_create_augroup("MesuraHostNoHighlight", { clear = true }),
  callback = function(event)
    pcall(vim.treesitter.stop, event.buf)
    pcall(function()
      vim.bo[event.buf].syntax = "off"
    end)
  end,
})
`;

/** The file name the plugin is written under, inside the scratch runtime path. */
export const HOST_PLUGIN_RELATIVE_PATH = "plugin/mesura_host.lua";
