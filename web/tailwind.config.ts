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
        sans: ["var(--font-sans)", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      fontSize: {
        display: ["28px", { lineHeight: "1.2", fontWeight: "600" }],
        title: ["20px", { lineHeight: "1.3", fontWeight: "600" }],
        subtitle: ["16px", { lineHeight: "1.4", fontWeight: "500" }],
        body: ["14px", { lineHeight: "1.5" }],
        caption: ["12px", { lineHeight: "1.4" }],
        label: ["11px", { lineHeight: "1.3", fontWeight: "500", letterSpacing: "0.04em" }],
      },
      borderRadius: { sm: "6px", md: "8px", lg: "12px", xl: "16px" },
      boxShadow: {
        drive: "0 1px 2px 0 rgb(60 64 67 / 0.302), 0 2px 6px 2px rgb(60 64 67 / 0.149)",
        e1: "0 1px 2px 0 rgb(60 64 67 / 0.20)",
        e2: "0 1px 3px 0 rgb(60 64 67 / 0.24), 0 4px 8px 3px rgb(60 64 67 / 0.10)",
        e3: "0 4px 8px 3px rgb(60 64 67 / 0.16), 0 8px 24px 6px rgb(60 64 67 / 0.10)",
      },
    },
  },
  plugins: [],
};

export default config;
