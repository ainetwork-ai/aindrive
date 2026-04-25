import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        drive: {
          bg: "#f8fafd",
          panel: "#ffffff",
          sidebar: "#f0f4f9",
          hover: "#e2e6ea",
          selected: "#c2e7ff",
          border: "#e2e8f0",
          text: "#1f1f1f",
          muted: "#5f6368",
          accent: "#0b57d0",
          accentHover: "#0842a0",
        },
      },
      fontFamily: {
        sans: ["Google Sans", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        drive: "0 1px 2px 0 rgb(60 64 67 / 0.302), 0 2px 6px 2px rgb(60 64 67 / 0.149)",
      },
    },
  },
  plugins: [],
};

export default config;
