@echo off

REM Run git commands
cd ..
cmd /c "git checkout master"
cmd /c "git pull"
cmd /c "git merge develop"
cmd /c "git push"
cmd /c "git checkout develop"