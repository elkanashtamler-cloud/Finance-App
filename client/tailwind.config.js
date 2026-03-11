/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      backdropBlur: {
        xs: '2px',
      },
      backgroundColor: {
        'glass': 'rgba(255, 255, 255, 0.08)',
        'glass-card': 'rgba(255, 255, 255, 0.12)',
      },
      borderColor: {
        'glass': 'rgba(255, 255, 255, 0.18)',
      },
      boxShadow: {
        'glass': '0 8px 32px 0 rgba(0, 0, 0, 0.2)',
      },
    },
  },
  plugins: [],
}
