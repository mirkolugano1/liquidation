@echo off

REM Check if a commit message is provided as an argument
set "commitMessage=%1"
if "%commitMessage%"=="" (
    set "commitMessage=Merged from develop branch"
)

REM Run git commands
cd ..
cmd /c "git checkout master"
cmd /c "git pull"
cmd /c "git merge develop -m \"%commitMessage%\""
cmd /c "git push"
cmd /c "git checkout develop"