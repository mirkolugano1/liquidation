@echo off

REM Run git commands
cd ..
git add .
git commit -m "Changes from develop branch"
git pull
git push
cd batch_scripts