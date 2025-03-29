@echo off

REM Run git commands
cd ..
git checkout master
git pull
git merge develop -m "Merged develop into master"
git push
git checkout develop
cd batch_scripts