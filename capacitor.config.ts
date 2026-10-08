import type { CapacitorConfig } from '@capacitor/cli';

// IMPORTANT: change appId to a reverse-domain ID you own before publishing
// (e.g. com.yourname.orbitdash). It cannot be changed after the first store release.
const config: CapacitorConfig = {
  appId: 'com.orbitdash.game',
  appName: 'Orbit Dash',
  webDir: 'dist',
  backgroundColor: '#0b0d1f',
  plugins: {
    SplashScreen: {
      launchShowDuration: 600,
      launchAutoHide: true,
      backgroundColor: '#0b0d1f',
      showSpinner: false,
    },
  },
  ios: {
    contentInset: 'never',
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
