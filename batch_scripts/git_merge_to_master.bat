@echo off

REM Run git commands
cd ..
cmd /c "git checkout master"
cmd /c "git pull"
cmd /c "git merge develop -m ""Merge develop branch to master"""
cmd /c "git push"
cmd /c "git checkout develop" 