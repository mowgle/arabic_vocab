# Arabic Vocabulary Trainer

A Leitner-system Arabic vocabulary trainer, deployable as a static site on
GitHub Pages with Firebase Firestore as the backend (so progress and shared
decks sync across devices by name, same as the original Claude artifact
version).

## 1. Create a Firebase project

1. Go to https://console.firebase.google.com and create a new project
   (the free "Spark" plan is enough for this app).
2. In the project, go to **Build → Firestore Database → Create database**.
   Choose **Start in test mode** for now (we'll paste stricter-but-still-open
   rules in step 3), pick any region, and create it.
3. Go to **Project settings** (gear icon) → scroll to **Your apps** → click
   the **</>** (web) icon to register a new web app. Give it any nickname —
   you don't need Firebase Hosting, just the SDK config.
4. Copy the `firebaseConfig` object it shows you.

## 2. Add your config to the project

Open `src/firebase.js` and replace the placeholder values with the config
you just copied. These values are safe to commit publicly — Firebase web
config isn't a secret; access is controlled by Firestore rules instead.

## 3. Deploy the Firestore security rules

This repo includes `firestore.rules`, which keeps the same "no login, open
by design" trust model as the original app. Easiest way to apply it:

- In the Firebase Console, go to **Firestore Database → Rules**, and paste
  the contents of `firestore.rules` in, then click **Publish**.

(Alternatively, install the Firebase CLI and run
`firebase deploy --only firestore:rules` — see comments in the file.)

## 4. Set the correct base path for GitHub Pages

Open `vite.config.js`. If your GitHub repo will be named e.g.
`arabic-vocab-trainer`, set:

```js
base: "/arabic-vocab-trainer/",
```

(If instead your repo is named exactly `your-username.github.io`, set
`base: "/"`.)

## 5. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

## 6. Turn on GitHub Pages

1. On GitHub, go to your repo's **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. That's it — the included workflow (`.github/workflows/deploy.yml`) will
   build the app with Vite and publish it automatically on every push to
   `main`. Check the **Actions** tab to watch it run.
4. After it finishes, your app will be live at:
   `https://YOUR_USERNAME.github.io/YOUR_REPO/`

## Local development

```bash
npm install
npm run dev
```
