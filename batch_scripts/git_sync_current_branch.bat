@echo off

REM Accept the commit message as an input parameter
set commit_message=%1

REM Run git commands
cd ..
cmd /c "git add ."
cmd /c "git commit -m \"%commit_message%\""
cmd /c "git pull"
cmd /c "git push"