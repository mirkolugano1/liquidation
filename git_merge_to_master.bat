@echo off

REM Run git commands
cmd /c "git checkout master"
cmd /c "git pull"
cmd /c "git merge develop"
cmd /c "git push"