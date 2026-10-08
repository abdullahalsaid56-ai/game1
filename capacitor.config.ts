import type { CapacitorConfig } from '@capacitor/cli';

// The app ID is permanent once the app is published in either store.
const config: CapacitorConfig = {
  appId: 'com.abdullahalsaid.orbitdash',
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
