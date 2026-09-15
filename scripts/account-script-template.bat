@echo off
setlocal EnableExtensions
rem ---------------------------------------------------------------------------
rem TEMPLATE for a per-account posting wrapper.
rem
rem To make a wrapper for a new account:
rem   1. Copy this file into scripts\account_scripts\
rem   2. Rename it to post-<account>.bat
rem   3. Edit the POST_USER / POST_PASSWORD lines below
rem   4. (Optional) change POST_SERVER if the account's server is elsewhere
rem
rem Usage (run from anywhere; paths are anchored to this file's location):
rem   post-<account>.bat "description" image1 [image2 ...]
rem
rem The description is %1; everything after it is treated as image paths and
rem uploaded together as ONE carousel post. Credentials are baked in here so
rem the LLM only ever needs to supply the description + image path(s).
rem ---------------------------------------------------------------------------
set "POST_USER=CHANGE_ME"
set "POST_PASSWORD=CHANGE_ME"
set "POST_SERVER=http://localhost:3000"

if "%~1"=="" (
  echo Usage: post-<account>.bat "description" image1 [image2 ...]
  exit /b 1
)

rem Capture this file's folder BEFORE shift (shift corrupts %~dp0 in cmd).
set "SCRIPT_DIR=%~dp0"

rem Pass the description via env (post.js reads POST_DESCRIPTION), then shift so
rem %1..%9 are the image paths. (cmd's %* always holds the FULL original arg list,
rem so we enumerate the remaining args explicitly after the shift.)
set "POST_DESCRIPTION=%~1"
shift

rem post.js lives in scripts\, one level up from this file's folder
rem (scripts\account_scripts\). SCRIPT_DIR..\post.js resolves to scripts\post.js.
node "%SCRIPT_DIR%..\post.js" --images %1 %2 %3 %4 %5 %6 %7 %8 %9
endlocal
