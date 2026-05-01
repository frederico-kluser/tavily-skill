# Publishing this repository

This repository is already prepared for GitHub publication.

## What is already set up

- Git repository structure is initialized locally
- root `package.json` includes the `pi-package` keyword
- root `package.json` includes a `pi.skills` manifest
- the actual skill lives at `skills/tavily/`
- documentation is fully in English
- no real secrets are included

## Publish to GitHub

1. Create a new empty repository on GitHub.
   Example:
   - owner: `YOUR_USERNAME`
   - repo: `tavily-skill`

2. Add the remote:

   ```bash
   git remote add origin git@github.com:YOUR_USERNAME/tavily-skill.git
   ```

   Or HTTPS:

   ```bash
   git remote add origin https://github.com/YOUR_USERNAME/tavily-skill.git
   ```

3. Push the repository:

   ```bash
   git push -u origin main
   ```

## After publishing

Users can install it with Pi directly from GitHub:

```bash
pi install https://github.com/YOUR_USERNAME/tavily-skill
```

Or manually for any Agent Skills-compatible harness by copying or symlinking:

```bash
skills/tavily -> ~/.agents/skills/tavily
```

## Optional: publish to npm later

If you want the package to participate in Pi's npm-based package ecosystem, you can later publish it to npm.

Before doing that, you may want to:
- choose a globally unique npm package name
- add repository/homepage metadata to `package.json`
- add screenshots/video metadata under the `pi` key if desired

Pi's package gallery is driven by npm packages tagged with `pi-package`.
