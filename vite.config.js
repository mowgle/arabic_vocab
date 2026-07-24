import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: "base" must match how your site is served on GitHub Pages.
//
// - If your repo is named "username.github.io" (a user/org page), use "/".
// - If your repo has any other name and you're using a PROJECT page
//   (https://username.github.io/REPO_NAME/), set base to "/REPO_NAME/"
//   exactly, including both slashes.
export default defineConfig({
  plugins: [react()],
  base: "/arabic_vocab/",
});
