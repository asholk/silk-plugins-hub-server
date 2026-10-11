#!/usr/bin/env bash
# Deploys Silk Plugins Hub to Yandex Cloud: a Cloud Function behind API Gateway, YDB and Object Storage.
#   bash deploy/deploy.sh
# Needs yc (configured with `yc init`). Creates the function and the gateway on the first run,
# then uploads a new function version and applies the scaling limits.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy/cloud.env ] || { echo "Copy deploy/cloud.env.example to deploy/cloud.env and fill it in." >&2; exit 1; }
source deploy/cloud.env
YC=${YC:-yc}

stage=$(mktemp -d)
spec=$(mktemp)
trap 'rm -rf "$stage" "$spec"' EXIT
cp -r src package.json package-lock.json "$stage/"

# Runs yc, retrying transient API failures (Internal, timeouts) a few times.
yc_retry() {
  local i out
  for i in 1 2 3 4 5 6; do
    if out=$("$YC" "$@" 2>&1); then
      echo "$out"
      return 0
    fi
    echo "yc $1 $2 $3 failed (attempt $i), retrying" >&2
    sleep $((i * 5))
  done
  echo "$out" >&2
  return 1
}

# Looks up a resource id by name in a list, so a failed call is never mistaken for "not found".
id_by_name() {
  node -e 'const [name, field] = process.argv.slice(1); const list = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]");
    const hit = list.find((x) => x.name === name); if (hit) console.log(hit[field]);' "$1" "$2"
}

function_id=$(yc_retry serverless function list --folder-id "$FOLDER_ID" --format json | id_by_name "$FUNCTION_NAME" id)
if [ -z "$function_id" ]; then
  yc_retry serverless function create --name "$FUNCTION_NAME" --folder-id "$FOLDER_ID" \
    --description "Silk Plugins Hub service" >/dev/null || true
  function_id=$(yc_retry serverless function list --folder-id "$FOLDER_ID" --format json | id_by_name "$FUNCTION_NAME" id)
  [ -n "$function_id" ] || { echo "Could not create the function" >&2; exit 1; }
  echo "Created function $function_id"
fi

# The gateway comes first: its domain is the service's public address (BASE_URL).
sed -e "s/{{FUNCTION_ID}}/$function_id/g" -e "s/{{GATEWAY_SA_ID}}/$GATEWAY_SA_ID/g" deploy/gateway.yaml > "$spec"
domain=$(yc_retry serverless api-gateway list --folder-id "$FOLDER_ID" --format json | id_by_name "$GATEWAY_NAME" domain)
if [ -z "$domain" ]; then
  yc_retry serverless api-gateway create --name "$GATEWAY_NAME" --folder-id "$FOLDER_ID" --spec "$spec" >/dev/null || true
  domain=$(yc_retry serverless api-gateway list --folder-id "$FOLDER_ID" --format json | id_by_name "$GATEWAY_NAME" domain)
  [ -n "$domain" ] || { echo "Could not create the API gateway" >&2; exit 1; }
  echo "Created API gateway"
else
  yc_retry serverless api-gateway update --name "$GATEWAY_NAME" --folder-id "$FOLDER_ID" --spec "$spec" >/dev/null
fi
base_url=${BASE_URL:-https://$domain}

secret_version=$(yc_retry lockbox secret get --id "$LOCKBOX_SECRET_ID" --format json | node -pe 'JSON.parse(require("fs").readFileSync(0)).current_version.id')
secret() { echo "environment-variable=$1,id=$LOCKBOX_SECRET_ID,version-id=$secret_version,key=$1"; }

google_client_id=$(grep -E '^GOOGLE_CLIENT_ID=' .env 2>/dev/null | cut -d= -f2- || true)

yc_retry serverless function version create \
  --function-id "$function_id" \
  --runtime nodejs22 \
  --entrypoint src/function.handler \
  --memory "$MEMORY" \
  --execution-timeout "$TIMEOUT" \
  --service-account-id "$FUNCTION_SA_ID" \
  --source-path "$stage" \
  --environment "STORE=ydb,FILES=s3,TRUST_PROXY=0,DEV_LOGIN=0,BASE_URL=$base_url,YDB_CONNECTION_STRING=$YDB_CONNECTION_STRING,S3_BUCKET=$S3_BUCKET,GOOGLE_CLIENT_ID=$google_client_id" \
  --secret "$(secret SESSION_SECRET)" \
  --secret "$(secret S3_ACCESS_KEY_ID)" \
  --secret "$(secret S3_SECRET_ACCESS_KEY)" \
  --secret "$(secret GOOGLE_CLIENT_SECRET)" >/dev/null

# Cost cap: requests above the limit get 429 instead of new instances.
yc_retry serverless function set-scaling-policy --id "$function_id" --tag '$latest' \
  --zone-instances-limit "$ZONE_INSTANCES_LIMIT" --zone-requests-limit "$ZONE_REQUESTS_LIMIT" >/dev/null

echo "Deployed: $base_url"
echo "Google OAuth redirect URI: $base_url/auth/google/callback"
