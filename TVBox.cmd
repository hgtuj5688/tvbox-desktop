@echo off
rem 打开 TVBox（开发模式：vite dev + 热更新，跑的是 src 里的当前代码）。
rem DSH「打开程序」插件面板里 TVBox.cmd 那一行的 ▶ 就是执行本文件；
rem 终端里 Ctrl+C 结束，或直接关掉终端标签。
cd /d "%~dp0"
call npm run dev %*
