# Deployment Guide - Google Cloud Run

This guide will help you deploy Magic Minutes to Google Cloud Run with automatic deployments from GitHub.

## Prerequisites

- A Google Cloud account ([sign up here](https://cloud.google.com/))
- Your GitHub repository (already set up at edufatouFlipas/magic-minutes)
- Your Discord bot credentials ready
- Your Google API key ready

## Deployment Options

We provide two deployment methods:
1. **Google Cloud Build (Recommended)** - Native GCP integration
2. **GitHub Actions** - Deploy from GitHub workflows

---

## Option 1: Google Cloud Build (Recommended)

This method uses Google Cloud Build triggers that automatically deploy when you push to GitHub.

### Step 1: Set Up Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Note your **Project ID** (you'll need this later)

### Step 2: Enable Required APIs

Run these commands in [Cloud Shell](https://cloud.google.com/shell) or your local terminal with gcloud installed:

```bash
# Enable required APIs
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable secretmanager.googleapis.com
```

### Step 3: Store Secrets in Secret Manager

Store your sensitive credentials securely:

```bash
# Set your project ID
export PROJECT_ID=your-project-id-here

# Create secrets
echo -n "YOUR_DISCORD_TOKEN" | gcloud secrets create discord-token --data-file=-
echo -n "YOUR_CLIENT_ID" | gcloud secrets create discord-client-id --data-file=-
echo -n "YOUR_GUILD_ID" | gcloud secrets create discord-guild-id --data-file=-
echo -n "YOUR_GOOGLE_API_KEY" | gcloud secrets create google-api-key --data-file=-

# Grant Cloud Run access to secrets
PROJECT_NUMBER=$(gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
gcloud secrets add-iam-policy-binding discord-token \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding discord-client-id \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding discord-guild-id \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding google-api-key \
    --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
```

### Step 4: Connect GitHub Repository

1. Go to [Cloud Build Triggers](https://console.cloud.google.com/cloud-build/triggers)
2. Click "Connect Repository"
3. Select "GitHub" as the source
4. Authenticate and select your repository: `edufatouFlipas/magic-minutes`
5. Click "Connect"

### Step 5: Create Build Trigger

1. Click "Create Trigger"
2. Configure the trigger:
   - **Name**: `deploy-magic-minutes`
   - **Event**: Push to a branch
   - **Source**: Select your repository
   - **Branch**: `^main$` (or your preferred branch)
   - **Configuration**: Cloud Build configuration file (yaml or json)
   - **Location**: `/cloudbuild.yaml`
3. Click "Create"

### Step 6: Deploy

Push to your main branch, and Cloud Build will automatically:
1. Build your Docker container
2. Push it to Google Container Registry
3. Deploy to Cloud Run
4. Your bot will start automatically!

### Step 7: Verify Deployment

Check your deployment:

```bash
# List Cloud Run services
gcloud run services list

# Get service URL (for health checks)
gcloud run services describe magic-minutes --region=us-central1 --format="value(status.url)"
```

Your bot should now be running! Check the Cloud Run logs:

```bash
gcloud run services logs read magic-minutes --region=us-central1
```

---

## Option 2: GitHub Actions Deployment

This method deploys directly from GitHub Actions.

### Step 1-3: Same as Option 1

Complete Steps 1-3 from Option 1 above.

### Step 2: Set Up GitHub Secrets

1. Go to your GitHub repository
2. Navigate to Settings → Secrets and variables → Actions
3. Add the following secrets:
   - `GCP_PROJECT_ID`: Your Google Cloud project ID
   - `GCP_SA_KEY`: Service account JSON key (see below)
   - `DISCORD_TOKEN`: Your Discord bot token
   - `CLIENT_ID`: Your Discord client ID
   - `GUILD_ID`: Your Discord guild ID
   - `GOOGLE_API_KEY`: Your Google API key

### Creating Service Account Key:

```bash
# Create service account
gcloud iam service-accounts create github-actions \
    --display-name="GitHub Actions"

# Grant necessary permissions
export PROJECT_ID=your-project-id-here
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:github-actions@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/run.admin"
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:github-actions@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/storage.admin"
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:github-actions@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/iam.serviceAccountUser"

# Create and download key
gcloud iam service-accounts keys create key.json \
    --iam-account=github-actions@${PROJECT_ID}.iam.gserviceaccount.com

# Copy the content of key.json and add it as GCP_SA_KEY secret in GitHub
cat key.json
```

### Step 3: GitHub Actions Workflow

The workflow file `.github/workflows/deploy.yml` has been created. It will automatically deploy on push to main.

### Step 4: Deploy

Push to your main branch, and GitHub Actions will handle the deployment!

---

## Monitoring and Logs

### View Logs

```bash
# Cloud Run logs
gcloud run services logs read magic-minutes --region=us-central1 --limit=50

# Follow logs in real-time
gcloud run services logs tail magic-minutes --region=us-central1
```

### Check Service Status

```bash
# Get service details
gcloud run services describe magic-minutes --region=us-central1

# Test health endpoint
curl $(gcloud run services describe magic-minutes --region=us-central1 --format="value(status.url)")/health
```

### Update Environment Variables

If you need to update secrets:

```bash
# Update a secret
echo -n "NEW_VALUE" | gcloud secrets versions add discord-token --data-file=-

# Redeploy to pick up new secrets
gcloud run services update magic-minutes --region=us-central1
```

---

## Updating the Bot

### Cloud Build Method
Just push to your main branch - automatic deployment!

```bash
git add .
git commit -m "Update bot"
git push origin main
```

### GitHub Actions Method
Same process - push to trigger deployment:

```bash
git add .
git commit -m "Update bot"
git push origin main
```

---

## Scaling and Resources

### Adjust Memory/CPU

```bash
# Increase memory to 1GB
gcloud run services update magic-minutes \
    --region=us-central1 \
    --memory=1Gi

# Set max instances
gcloud run services update magic-minutes \
    --region=us-central1 \
    --max-instances=10
```

### Cost Optimization

Cloud Run pricing:
- **Free tier**: 2 million requests/month
- **Pay per use**: Only charged when bot is active
- Your bot runs 24/7 with minimal HTTP traffic (only health checks)

Estimated cost: ~$5-15/month depending on voice recording usage

---

## Troubleshooting

### Bot not responding to commands

1. Check logs for errors
2. Verify secrets are correctly set
3. Ensure Discord bot permissions are correct
4. Check bot is online in Discord server

### Deployment fails

1. Check Cloud Build logs
2. Verify all APIs are enabled
3. Ensure service account has correct permissions

### Voice recording issues

1. Check memory allocation (may need 1GB for multiple users)
2. Review Cloud Run logs during recording
3. Verify ffmpeg-static is working in container

---

## Security Best Practices

1. **Never commit secrets** - Use Secret Manager or GitHub Secrets
2. **Rotate tokens regularly** - Update secrets periodically
3. **Monitor access logs** - Review Cloud Run audit logs
4. **Restrict service account permissions** - Use principle of least privilege
5. **Keep dependencies updated** - Run `npm audit` regularly

---

## Support

For deployment issues:
- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [GitHub Issues](https://github.com/edufatouFlipas/magic-minutes/issues)

For bot issues:
- Check the main README.md
- Review Discord bot permissions
