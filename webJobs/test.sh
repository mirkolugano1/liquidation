#!/bin/bash

# Navigate to the base directory of your app
cd /home/site/wwwroot

# Run the script defined in package.json with the provided parameter
npm run webJob testJob

# Check the exit status of the last command
if [ $? -eq 0 ]; then
  echo "WebJob completed successfully."
else
  echo "WebJob failed with exit code $?."