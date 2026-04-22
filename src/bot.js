process.env.DEBUG = 'ethers:*';
require('dotenv').config();

const ethers = require('ethers');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const http = require('http');
const axios = require('axios');

const { settings } = require('./config');
const { handleError } = require('./handlers/errorHandler');
const logger = require('./utils/logger');
const ClankerContractHelper = require('./contracts/helpers/ClankerContractHelper');

class ClankerBot {
    constructor() {
        this.provider = null;
        this.discord = null;
        this.initialize();
    }

    async initialize() {
        try {
            this.provider = new ethers.WebSocketProvider(
                `wss://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
                { name: 'base', chainId: 8453 }
            );
            await this.initializeDiscord();
            this.clankerContracts = new ClankerContractHelper(this.provider);
            await this.setupEventListeners();
            
            console.log('Bot is running: Monitoring Clanker V4 with GeckoTerminal API...');
        } catch (error) {
            console.error('Init Error:', error);
        }
    }

    async initializeDiscord() {
        this.discord = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });
        await this.discord.login(process.env.DISCORD_TOKEN);
    }

    async setupEventListeners() {
        this.clankerContracts.clankerFactoryV4.on('TokenCreated',
            async (msgSender, tokenAddress, tokenAdmin, tokenImage, tokenName, tokenSymbol, tokenMetadata, tokenContext, startingTick, poolHook, poolId, pairedToken, locker, mevModule, extensionsSupply, extensions, event) => {
                try {
                    console.log(` [V4] Token Terdeteksi: ${tokenName}. Memulai scan di GeckoTerminal...`);
                    
                    let poolData = null;
                    // LOOPING 7X, TIAP 30 DETIK (Total 3.5 Menit)
                    for (let i = 0; i < 7; i++) {
                        await new Promise(resolve => setTimeout(resolve, 30000));
                        
                        try {
                            // Menggunakan API GeckoTerminal untuk mencari pool berdasarkan alamat token
                            const response = await axios.get(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}/pools`);
                            
                            if (response.data && response.data.data && response.data.data.length > 0) {
                                // Ambil pool pertama yang ditemukan
                                poolData = response.data.data[0].attributes;
                                console.log(` [V4] Data ditemukan di GeckoTerminal pada percobaan ke-${i + 1}`);
                                break; 
                            }
                        } catch (e) {
                            console.log(` Percobaan ${i + 1}: GeckoTerminal belum indeks, nunggu lagi...`);
                        }
                    }

                    if (!poolData) {
                        console.log(` [V4] Token ${tokenName} tidak ketemu di GeckoTerminal setelah 3,5 menit.`);
                        return;
                    }

                    // Mapping data dari GeckoTerminal
                    const volume = parseFloat(poolData.volume_usd?.h24 || 0);
                    const buys = parseInt(poolData.transactions?.h24?.buys || 0);
                    const growth = parseFloat(poolData.price_change_percentage?.h1 || 0);

                    console.log(` Filter Check (${tokenSymbol}): Vol=$${volume.toFixed(2)}, Buys=${buys}, Growth=${growth}%`);

                    // LOGIKA ATAU (||) - Sesuai request: salah satu terpenuhi langsung tembak
                    if (volume >= 1000 || buys >= 10 || growth >= 100) {
                        const channel = await this.discord.channels.fetch(process.env.DISCORD_CLANKER_CHANNEL_ID);
                        
                        const embed = new EmbedBuilder()
                            .setColor(0x00FF00)
                            .setTitle('🚀 GECKO ALERT: Lolos Filter!')
                            .setDescription(`**${tokenName}** (${tokenSymbol})`)
                            .addFields(
                                { name: 'Volume 24h', value: `$${volume.toLocaleString()}`, inline: true },
                                { name: 'Buys 24h', value: `${buys}`, inline: true },
                                { name: 'Growth 1h', value: `${growth.toFixed(2)}%`, inline: true },
                                { name: 'Address', value: `\`${tokenAddress}\``, inline: false },
                                { name: 'Links', value: `[GeckoTerminal](https://www.geckoterminal.com/base/pools/${tokenAddress})\n[DexScreener](https://dexscreener.com/base/${tokenAddress})\n[Clanker](https://www.clanker.world/clanker/${tokenAddress})\n[Basescan](https://basescan.org/address/${tokenAddress})`, inline: false }
                            )
                            .setTimestamp()
                            .setFooter({ text: 'Powered by GeckoTerminal API' });

                        await channel.send({ content: `🚨 **NEW POTENTIAL GEM FOUND!**`, embeds: [embed] });
                        console.log(` ✅ Notif terkirim ke Discord untuk ${tokenName}`);
                    } else {
                        console.log(` ❌ ${tokenName} skip (Gak ada syarat yang terpenuhi)`);
                    }
                } catch (error) {
                    console.error(' Error V4 Handler:', error.message);
                }
            }
        );
    }
}

// Web Server buat Railway anti-mati
http.createServer((req, res) => { res.writeHead(200); res.end('Bot Gecko is running!'); }).listen(process.env.PORT || 8080);

new ClankerBot();