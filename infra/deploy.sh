#!/usr/bin/env bash
# Build and deploy the Apia map to S3 + CloudFront.
#
#   npm run deploy
#
# Idempotent: creates the stack on first run, updates it after that. Uploads in
# two passes so hashed assets get an immutable cache header while the entry
# point and data stay short-lived.
#
# Required: AWS credentials in the environment (or AWS_PROFILE), and the AWS CLI v2.

set -euo pipefail

PROJECT="${PROJECT:-apia-map}"
STACK="${STACK:-$PROJECT}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-ap-southeast-2}}"   # Sydney: closest bulk region to Samoa
DOMAIN="${DOMAIN:-}"
CERT_ARN="${CERT_ARN:-}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
PRICE_CLASS="${PRICE_CLASS:-PriceClass_All}"

# CloudFront only reads certificates from us-east-1, whatever region the rest of
# the stack lives in. This is not configurable.
CERT_REGION=us-east-1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIST="$ROOT/dist"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[31merror: %s\033[0m\n' "$1" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "AWS CLI not found. Install AWS CLI v2 first."
aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 \
  || die "AWS credentials are not working. Set AWS_PROFILE or the AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN variables."

step "Account and region"
aws sts get-caller-identity --region "$REGION" --output table
echo "Region: $REGION"

step "Building the site"
cd "$ROOT"
if [ ! -f public/data/apia.geojson ]; then
  echo "warning: public/data/apia.geojson is missing." >&2
  echo "         The deployed map will fall back to querying Overpass live in the visitor's browser," >&2
  echo "         which is slow and unreliable for a public site." >&2
  echo "         Run 'npm run fetch:data' first for a proper build." >&2
  echo >&2
fi
npm run build

[ -d "$DIST" ] || die "build produced no dist/ directory"

# --- Custom domain: hosted zone, certificate, validation ---------------------
#
# All of this is idempotent. An existing zone is reused, an existing issued
# certificate for the domain is reused, and re-running after a partial failure
# picks up where it left off.

if [ -n "$DOMAIN" ]; then
  step "Custom domain: $DOMAIN"

  if [ -z "$HOSTED_ZONE_ID" ]; then
    # Walk up the labels: apia.example.co.nz -> example.co.nz -> co.nz, and use
    # the most specific hosted zone this account actually owns.
    probe="$DOMAIN"
    while [ -n "$probe" ] && [ -z "$HOSTED_ZONE_ID" ]; do
      HOSTED_ZONE_ID="$(aws route53 list-hosted-zones-by-name --dns-name "$probe" \
        --query "HostedZones[?Name=='${probe}.'].Id | [0]" --output text 2>/dev/null || true)"
      [ "$HOSTED_ZONE_ID" = "None" ] && HOSTED_ZONE_ID=""
      [ -n "$HOSTED_ZONE_ID" ] && break
      case "$probe" in
        *.*.*) probe="${probe#*.}" ;;
        *) probe="" ;;
      esac
    done
    HOSTED_ZONE_ID="${HOSTED_ZONE_ID##*/}"   # strip the /hostedzone/ prefix
  fi

  [ -n "$HOSTED_ZONE_ID" ] || die "no Route 53 hosted zone found for $DOMAIN in this account.
  Create the zone first, or pass HOSTED_ZONE_ID=... to skip discovery, or leave
  DOMAIN unset to deploy on the CloudFront domain."
  echo "Hosted zone: $HOSTED_ZONE_ID"

  if [ -z "$CERT_ARN" ]; then
    CERT_ARN="$(aws acm list-certificates --region "$CERT_REGION" \
      --certificate-statuses ISSUED PENDING_VALIDATION \
      --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn | [0]" \
      --output text 2>/dev/null || true)"
    [ "$CERT_ARN" = "None" ] && CERT_ARN=""
  fi

  if [ -z "$CERT_ARN" ]; then
    echo "Requesting a certificate in $CERT_REGION..."
    CERT_ARN="$(aws acm request-certificate --region "$CERT_REGION" \
      --domain-name "$DOMAIN" --validation-method DNS \
      --query CertificateArn --output text)"
    # ACM populates the validation record asynchronously.
    for _ in $(seq 1 30); do
      READY="$(aws acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
        --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text 2>/dev/null || true)"
      [ -n "$READY" ] && [ "$READY" != "None" ] && break
      sleep 2
    done
  fi
  echo "Certificate: $CERT_ARN"

  CERT_STATUS="$(aws acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
    --query 'Certificate.Status' --output text)"

  if [ "$CERT_STATUS" != "ISSUED" ]; then
    echo "Writing the DNS validation record..."
    RR_NAME="$(aws acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
      --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Name' --output text)"
    RR_VALUE="$(aws acm describe-certificate --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
      --query 'Certificate.DomainValidationOptions[0].ResourceRecord.Value' --output text)"
    [ -n "$RR_NAME" ] && [ "$RR_NAME" != "None" ] || die "ACM has not published a validation record yet; re-run in a minute."

    # UPSERT, so re-running never conflicts with a record already there.
    aws route53 change-resource-record-sets --hosted-zone-id "$HOSTED_ZONE_ID" \
      --change-batch "{
        \"Comment\": \"ACM validation for ${DOMAIN}\",
        \"Changes\": [{
          \"Action\": \"UPSERT\",
          \"ResourceRecordSet\": {
            \"Name\": \"${RR_NAME}\",
            \"Type\": \"CNAME\",
            \"TTL\": 300,
            \"ResourceRecords\": [{\"Value\": \"${RR_VALUE}\"}]
          }
        }]
      }" >/dev/null

    echo "Waiting for the certificate to validate (usually 2-5 minutes)..."
    aws acm wait certificate-validated --region "$CERT_REGION" --certificate-arn "$CERT_ARN" \
      || die "certificate did not validate. Check the CNAME above exists in zone $HOSTED_ZONE_ID."
  fi
  echo "Certificate issued."
fi

step "Deploying the stack ($STACK)"
PARAMS=(ProjectName="$PROJECT" PriceClass="$PRICE_CLASS")
if [ -n "$DOMAIN" ] && [ -n "$CERT_ARN" ]; then
  PARAMS+=(DomainName="$DOMAIN" AcmCertificateArn="$CERT_ARN" HostedZoneId="$HOSTED_ZONE_ID")
  echo "Custom domain: $DOMAIN"
fi

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK" \
  --template-file "$HERE/cloudfront.yaml" \
  --parameter-overrides "${PARAMS[@]}" \
  --no-fail-on-empty-changeset

outputs() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

BUCKET="$(outputs BucketName)"
DIST_ID="$(outputs DistributionId)"
URL="$(outputs SiteURL)"
[ -n "$BUCKET" ] || die "could not read the bucket name from the stack outputs"

step "Uploading to s3://$BUCKET"

# 1. Immutable, content-hashed assets and the basemap archive.
aws s3 sync "$DIST" "s3://$BUCKET" \
  --region "$REGION" --delete \
  --exclude '*' --include 'assets/*' --include 'basemap/*' \
  --cache-control 'public,max-age=31536000,immutable'

# .pmtiles must be served as an opaque binary so CloudFront honours range requests.
if [ -d "$DIST/basemap" ]; then
  aws s3 cp "s3://$BUCKET/basemap/" "s3://$BUCKET/basemap/" \
    --region "$REGION" --recursive --metadata-directive REPLACE \
    --content-type 'application/octet-stream' \
    --cache-control 'public,max-age=31536000,immutable' >/dev/null
fi

# 2. Everything else: short-lived so a redeploy is picked up promptly.
aws s3 sync "$DIST" "s3://$BUCKET" \
  --region "$REGION" --delete \
  --exclude 'assets/*' --exclude 'basemap/*' \
  --cache-control 'public,max-age=60,must-revalidate'

# The service worker must never be cached, or clients get stuck on an old shell.
if [ -f "$DIST/sw.js" ]; then
  aws s3 cp "$DIST/sw.js" "s3://$BUCKET/sw.js" \
    --region "$REGION" --content-type 'application/javascript' \
    --cache-control 'no-cache,max-age=0,must-revalidate' >/dev/null
fi

step "Invalidating CloudFront"
INVALIDATION="$(aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" --paths '/*' \
  --query 'Invalidation.Id' --output text)"
echo "Invalidation $INVALIDATION created."

step "Done"
echo "Site:         $URL"
echo "Bucket:       $BUCKET"
echo "Distribution: $DIST_ID"
echo
echo "A brand new distribution takes a few minutes to finish deploying to the edge."
