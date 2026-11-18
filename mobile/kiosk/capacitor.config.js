// 서버 주소: SSSMS_SERVER_URL=https://야자실.도메인 npx cap sync
const server = (process.env.SSSMS_SERVER_URL || 'https://yaja.example.com').replace(/\/+$/, '');

module.exports = {
  appId: 'kr.hs.sunrint.yaja.kiosk',
  appName: '선린 야자실 키오스크',
  webDir: 'www',
  server: { url: `${server}/kiosk/`, cleartext: server.startsWith('http://'), allowNavigation: [new URL(server).host] },
  ios: { contentInset: 'never', backgroundColor: '#000000' },
  android: { backgroundColor: '#000000' },
};
