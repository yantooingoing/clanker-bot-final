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
            
            console.log('Bot is running and monitoring Clanker V4...');
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
                    console.log(` [V4] Token Terdeteksi: ${tokenName}. Memulai scan looping...`);
                    
                    let pair = null;
                    // LOOPING 7X, TIAP 30 DETIK (Total 3.5 Menit)
                    for (let i = 0; i < 7; i++) {
                        await new Promise(resolve => setTimeout(resolve, 30000));
                        
                        try {
                            const response = await axios.get(`https://api.dexscreener.com/latest/dex/pairs/base/${tokenAddress}`);
                            if (response.data.pair) {
                                pair = response.data.pair;
                                console.log(` [V4] Data ditemukan pada percobaan ke-${i + 1}`);
                                break; 
                            }
                        } catch (e) {
                            console.log(` Percobaan ${i + 1}: Data belum tersedia, menunggu...`);
                        }
                    }

                    if (!pair) {
                        console.log(` [V4] Token ${tokenName} tidak muncul di DexScreener setelah 3,5 menit.`);
                        return;
                    }

                    const volume = pair.volume?.h24 || 0;
                    const buys = pair.txns?.h24?.buys || 0;
                    const growth = pair.priceChange?.h1 || 0;

                    console.log(` Filter: Vol=$${volume}, Buys=${buys}, Growth=${growth}%`);

                    // LOGIKA ATAU (||) - Cukup salah satu syarat
                    if (volume >= 1000 || buys >= 10 || growth >= 100) {
                        const channel = await this.discord.channels.fetch(process.env.DISCORD_CLANKER_CHANNEL_ID);
                        
                        const embed = new EmbedBuilder()
                            .setColor(0x00FF00)
                            .setTitle('🚀 GEM ALERT: Lolos Filter!')
                            .setDescription(`**${tokenName}** (${tokenSymbol})`)
                            .addFields(
                                { name: 'Volume 24h', value: `$${volume}`, inline: true },
                                { name: 'Buys 24h', value: `${buys}`, inline: true },
                                { name: 'Growth 1h', value: `${growth}%`, inline: true },
                                { name: 'Address', value: `\`${tokenAddress}\``, inline: false },
                                { name: 'Links', value: `[Basescan](https://basescan.org/address/${tokenAddress})\n[DexScreener](https://dexscreener.com/base/${tokenAddress})\n[Clanker.world](https://www.clanker.world/clanker/${tokenAddress})`, inline: false }
                            )
                            .setTimestamp();

                        await channel.send({ content: `🚨 **NEW POTENTIAL GEM**`, embeds: [embed] });
                        console.log(` ✅ Notif dikirim untuk ${tokenName}`);
                    }
                } catch (error) {
                    console.error(' Error V4:', error.message);
                }
            }
        );
    }
}

// Anti-tidur untuk hosting
http.createServer((req, res) => { res.writeHead(200); res.end('Bot is running!'); }).listen(process.env.PORT || 8080);

new ClankerBot();