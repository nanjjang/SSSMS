// 서버 주소: SSSMS_SERVER_URL=https://야자실.도메인 npx cap sync
const server = (process.env.SSSMS_SERVER_URL || 'https://yaja.example.com').replace(/\/+$/, '');

module.exports = {
  appId: 'kr.hs.sunrint.yaja',
  appName: '선린 야자실',
  webDir: 'www', // 서버에 접속하지 못할 때 보여줄 안내 화면
  server: { url: `${server}/student/`, cleartext: server.startsWith('http://'), allowNavigation: [new URL(server).host] },
  ios: { contentInset: 'never', backgroundColor: '#ffffff' },
  android: { backgroundColor: '#ffffff' },
};
