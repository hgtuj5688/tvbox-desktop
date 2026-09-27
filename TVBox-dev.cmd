@echo off
rem 打开 TVBox 开发模式（vite dev + 热更新，改 src 立即生效）。
rem 这也是 DSH「打开程序」插件面板里那个 ▶ 要跑的东西。
cd /d "%~dp0"
call npm run dev
