@echo off
setlocal

REM Build ai_trader.html from src/ files
REM Usage: build.cmd

set "SCRIPT_DIR=%~dp0"
set "SRC=%SCRIPT_DIR%src"
set "OUT=%SCRIPT_DIR%index.html"

REM Verify source files exist
if not exist "%SRC%\template.html" (
    echo ERROR: %SRC%\template.html not found
    exit /b 1
)
if not exist "%SRC%\styles.css" (
    echo ERROR: %SRC%\styles.css not found
    exit /b 1
)
if not exist "%SRC%\body.html" (
    echo ERROR: %SRC%\body.html not found
    exit /b 1
)
if not exist "%SRC%\trader.js" (
    echo ERROR: %SRC%\trader.js not found
    exit /b 1
)

REM Use PowerShell to assemble the file line-by-line (like awk in build.sh)
REM Each placeholder line is replaced by the entire contents of the corresponding file
powershell -NoProfile -Command ^
    "$ErrorActionPreference = 'Stop';" ^
    "$enc = New-Object System.Text.UTF8Encoding $false;" ^
    "$template = [System.IO.File]::ReadAllLines('%SRC%\template.html', $enc);" ^
    "$styles = [System.IO.File]::ReadAllText('%SRC%\styles.css', $enc);" ^
    "$body = [System.IO.File]::ReadAllText('%SRC%\body.html', $enc);" ^
    "$js = [System.IO.File]::ReadAllText('%SRC%\trader.js', $enc);" ^
    "$nl = \"`n\";" ^
    "$sb = New-Object System.Text.StringBuilder;" ^
    "foreach ($line in $template) {" ^
    "  if ($line.Contains('<!-- STYLES -->')) { [void]$sb.Append($styles) }" ^
    "  elseif ($line.Contains('<!-- BODY -->')) { [void]$sb.Append($body) }" ^
    "  elseif ($line.Contains('<!-- SCRIPT -->')) { [void]$sb.Append($js) }" ^
    "  else { [void]$sb.Append($line + $nl) }" ^
    "};" ^
    "[System.IO.File]::WriteAllText('%OUT%', $sb.ToString(), $enc);"

if %ERRORLEVEL% neq 0 (
    echo ERROR: Build failed
    exit /b 1
)

echo Built: %OUT%
