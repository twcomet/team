module.exports = {
  apps: [{
    name: 'huixin-case-system',
    script: 'server.js',
    cwd: '/var/www/huixin/case-system',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000,
    },
  }],
};
