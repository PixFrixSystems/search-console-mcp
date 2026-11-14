→# Authentication

The server needs permission to read your Search Console data. There are two ways to give it that, and both are free. You do not need billing enabled in Google Cloud.

| | Service account | Your own Google account (OAuth) |
|---|---|---|
| What it is | A robot account with its own email address | You, signing in through the browser once |
| Sees | Only the properties you add it to | Every property your account can see |
| Best for | Agencies, shared setups, servers, scheduled jobs | One person who already has access to many properties |
| Expires | Never, until you delete the key | Never once the consent screen is published (weekly while it is in Testing) |

If you are unsure, start with a service account when you manage a handful of sites, and with your own account when you have dozens.

Both start the same way.

## Before either: a Google Cloud project with the API enabled

1. Open the [Google Cloud console](https://console.cloud.google.com/) and create a project (or pick an existing one). The name does not matter.
2. Go to **APIs & Services > Library**, search for **Google Search Console API** and click **Enable**.

## Option A: service account

1. In the Cloud console go to **IAM & Admin > Service Accounts** and click **Create service account**.
2. Give it a name such as `search-console-mcp` and click **Create and continue**. Skip the optional role and access steps: it needs no Google Cloud roles.
3. Open the new service account, go to the **Keys** tab and choose **Add key > Create new key > JSON**. A `.json` file downloads. Keep it somewhere private, outside any git repository.
4. Copy the service account's email address. It looks like `search-console-mcp@your-project.iam.gserviceaccount.com`.
5. Open [Search Console](https://search.google.com/search-console), select a property, and go to **Settings > Users and permissions > Add user**. Paste the email address.
   - **Restricted** is enough for every read-only tool.
   - Choose **Full** if you plan to enable `submit_sitemap` and `delete_sitemap`.
6. Repeat step 5 for each property you want the server to reach.
7. Point the server at the key:

   ```bash
   GSC_SERVICE_ACCOUNT_KEY=/path/to/key.json npx -y @pixfrix/search-console-mcp doctor
   ```

If key creation is blocked with a message about an organisation policy (`iam.disableServiceAccountKeyCreation`), your Google Workspace administrator has disabled service account keys. Use Option B instead.

To add a property later, repeat step 5. The server finds it the next time you name it; nothing needs restarting.

## Option B: your own Google account

1. In the Cloud console open **Google Auth Platform** (older projects call it **APIs & Services > OAuth consent screen**) and click **Get started**.
2. Fill in an app name and your email, choose **External** as the audience, and finish the form.
3. Go to **Audience**. While the app is in **Testing**, add your own Google address under **Test users**.
4. Go to **Clients > Create client**, choose application type **Desktop app**, and create it. Download the JSON file.
5. Sign in:

   ```bash
   GSC_OAUTH_CLIENT_FILE=/path/to/client_secret.json npx -y @pixfrix/search-console-mcp auth login
   ```

   Your browser opens. Choose the Google account that has access to Search Console and approve. Because this is your own unverified app, Google shows a "Google hasn't verified this app" notice: choose **Advanced** and continue.
6. Check the result:

   ```bash
   npx -y @pixfrix/search-console-mcp doctor
   ```

After this the server needs no environment variables for credentials: the sign-in is saved in the config directory (`~/.config/search-console-mcp`, or `%APPDATA%\search-console-mcp` on Windows).

### Stop the sign-in expiring every week

Google expires sign-ins after seven days for apps in **Testing** status. To make yours last, open **Google Auth Platform > Audience** and click **Publish app**. For a personal tool you do not need to complete Google's verification: the notice from step 5 simply stays.

### Allow sitemap changes

The default sign-in is read-only. To use `submit_sitemap` and `delete_sitemap`, sign in again with the write scope and enable the tools:

```bash
npx -y @pixfrix/search-console-mcp auth login --write
```

Then set `GSC_ALLOW_WRITE=true` in your MCP client's configuration.

### Signing in on a machine without a browser

Run `auth login --no-browser`. The command prints the sign-in address instead of opening it. The address redirects to `127.0.0.1`, so the browser must be on the same machine, or the port must be forwarded (for example with `ssh -L`).

### Sign out

```bash
npx -y @pixfrix/search-console-mcp auth logout
```

This deletes the saved token. To also revoke the grant on Google's side, remove the app at [myaccount.google.com/connections](https://myaccount.google.com/connections).

## Other ways to provide credentials

- **`GSC_SERVICE_ACCOUNT_JSON`**: the service account key as a JSON string instead of a file. Useful in containers and CI, where secrets arrive as environment variables.
- **`GOOGLE_APPLICATION_CREDENTIALS`**: Google's standard variable. Honoured when the two `GSC_` variables are not set.
- **Application Default Credentials**: when nothing else is configured, the server tries Google's default chain, which covers the identity attached to a Google Cloud runtime and a local `gcloud auth application-default login`. With gcloud you must pass your own client and the Search Console scope:

  ```bash
  gcloud auth application-default login \
    --client-id-file=/path/to/client_secret.json \
    --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform
  ```

The lookup order is: `GSC_SERVICE_ACCOUNT_JSON`, `GSC_SERVICE_ACCOUNT_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, a saved `auth login`, then Application Default Credentials. `doctor` prints which one was used.

## Keeping credentials safe

- Never commit a key or client secret file. The repository's `.gitignore` covers the usual file names, but check before you push.
- A service account can only read the properties you added it to. Remove it from a property under **Users and permissions** to cut access immediately.
- Delete a leaked service account key under **IAM & Admin > Service Accounts > Keys**. The key stops working at once.
- The saved OAuth token is a plain file readable by your user account, the same approach `gcloud` uses. Treat the config directory like you treat `~/.ssh`.
