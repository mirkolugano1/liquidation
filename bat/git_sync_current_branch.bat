@echo off

if "%~1"=="" (
    echo ERROR: No commit message provided.
    exit /b 1
)

REM Run git commands
cd ..
git add .
git commit -m %1
git pull
git push
cd batch_scripts