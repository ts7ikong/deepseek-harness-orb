@echo off
rem Starts the floating ball (DeepSeek Orb) from this checkout. Double-click it, or put a shortcut to it in
rem shell:startup to have the ball start when you sign in.
rem The ball keeps running after this window closes; to stop it, right-click the ball and choose Quit.
cd /d "%~dp0"
set NODE_USE_ENV_PROXY=1
start "" /min cmd /c "pnpm run start:desktop > "%TEMP%\orb-start.log" 2>&1"
