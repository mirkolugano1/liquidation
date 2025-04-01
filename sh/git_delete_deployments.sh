# delete all deployments except the last one
gh api repos/mirkolugano1/liquidation/deployments --jq '.[].id' > deployments.txt
LAST_DEPLOYMENT_ID=$(gh api repos/mirkolugano1/liquidation/deployments --jq '.[0].id')                
cat deployments.txt | while read -r deployment_id; do
if [ "$deployment_id" != "$LAST_DEPLOYMENT_ID" ]; then
    echo "Deleting deployment $deployment_id"
    gh api -X DELETE "repos/mirkolugano1/liquidation/deployments/$deployment_id"
else
    echo "Skipping last deployment $deployment_id"
fi
done
rm -rf deployments.txt