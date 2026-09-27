@echo off
rem 秒开：用已经构建好的 out\ 直接起 Electron，不走 vite（不编译、不等打包）。
rem 注意：看到的是上一次 npm run build 的快照；改了 src 就先 npm run build。
cd /d "%~dp0"
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo [TVBox] 没找到 electron，请先在本目录执行: npm install
  exit /b 1
)
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0" %*
