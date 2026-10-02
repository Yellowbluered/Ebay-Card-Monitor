@echo off
REM ---------------------------------------------------------------
REM Windows 啟動腳本：先切到 UTF-8 字碼頁，避免中文/框線字變亂碼。
REM 用法：
REM   run.cmd "charizard psa 10"
REM   run.cmd --demo
REM   run.cmd "charizard psa 10" --source scrape --headed
REM ---------------------------------------------------------------
chcp 65001 >nul
node "%~dp0src\index.js" %*
exit /b %ERRORLEVEL%
