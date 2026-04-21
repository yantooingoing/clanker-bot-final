process.env.DEBUG = 'ethers:*';

// Load environment variables first
require('dotenv').config();

// === VALIDASI: HANYA BUTUH 3 VARIABEL INI SAJA ===
if (!process.env.DISCORD_TOKEN || 
    !process.env.ALCHEMY_API_KEY || 
    !process.env.DISCORD_CLANKER_CHANNEL_ID) {
    console.error('Missing required environment variables: DISCORD_TOKEN, ALCHEMY_API_KEY, or DISCORD_CLANKER_CHANNEL_ID');
    process.exit(1);
}

// Third-party dependencies
const ethers = require('ethers');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const http = require('http'); // Ditambahkan agar bot tidak mati di Railway

// Local imports
const { settings } = require('./config');
const { handleError } = require('./handlers/errorHandler');
const { handleClankerToken } = require('./handlers/clankerTokenHandler');
const { handlePresaleCreated, handlePresalePurchase } = require('./handlers/presaleHandler');

const logger = require('./utils/logger');
const MAX_RETRIES = 5;
const ClankerContractHelper = require('./contracts/helpers/ClankerContractHelper');

class ClankerBot {
    constructor() {
        this.provider = null;
        this.discord = null;
        this.isReconnecting = false;
        this.isShuttingDown = false;
        this.lastEventTime = Date.now();
        this.healthCheckInterval = null;
        this.reconnectAttempts = 0;
        this.initCount = 0;

        this.setupCleanupHandlers();
        this.initialize();
    }

    setupCleanupHandlers() {
        ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
            process.on(signal, async () => {
                logger.info(`\n${signal} received. Starting cleanup...`);
                await this.cleanup(true);
            });
        });

        process.on('uncaughtException', async (error) => {
            logger.error(`Uncaught Exception: ${error.message}`);
            console.error(error);
            await this.cleanup(true);
        });

        process.on('unhandledRejection', async (error) => {
            logger.error(`Unhandled Rejection: ${error.message}`);
            console.error(error);
            await this.cleanup(true);
        });
    }

    async initialize() {
        if (this.isShuttingDown) return;
        
        try {
            logger.section(' Initializing Bot');
            
            this.provider = new ethers.WebSocketProvider(
                `wss://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
                { name: 'base', chainId: 8453 }
            );
            
            await this.provider.ready;
            logger.detail(' Provider Connected');
            
            await this.initializeDiscord();
            logger.detail(' Discord client ready');
            logger.sectionEnd();
            
            this.clankerContracts = new ClankerContractHelper(this.provider);
            logger.detail(' All contracts initialized successfully');
            logger.sectionEnd();
            
            await this.verifyContracts();
            logger.detail(' All contracts verified successfully');
            logger.sectionEnd();
            
            await this.setupEventListeners();
            logger.detail(' All event listeners set up successfully');
            logger.sectionEnd();
            
            this.startHealthCheck();
            this.startPingPong();
            
            logger.sectionEnd();
            logger.section(' Bot Initialization Complete');
            logger.detail(' We are clanking...');
            logger.sectionEnd();
            
        } catch (error) {
            logger.error(`Initialization error: ${error.message}`);
            if (this.initCount < MAX_RETRIES) {
                const delay = Math.min(1000 * Math.pow(2, this.initCount), 30000);
                logger.info(`Retrying initialization in ${delay}ms`);
                setTimeout(() => this.initialize(), delay);
            } else {
                process.exit(1);
            }
        }
    }

    async initializeDiscord() {
        return new Promise((resolve, reject) => {
            this.discord = new Client({
                intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
            });
            
            this.discord.once('ready', () => resolve());
            this.discord.on('error', (error) => handleError(error, 'Discord Client'));
            this.discord.login(process.env.DISCORD_TOKEN).catch(reject);
        });
    }

    async verifyContracts() {
        const contractsToVerify = [
            ['Clanker Factory', this.clankerContracts.clankerFactory],
            ['Clanker Presale', this.clankerContracts.clankerPresale]
        ];

        for (const [name, contract] of contractsToVerify) {
            const code = await this.provider.getCode(contract.target);
            if (code === '0x' || code.length < 10) {
                throw new Error(`${name} contract not found`);
            }
            logger.detail(`${name} verified`, contract.target);
        }
    }

    async setupEventListeners() {
        // V3 Listener
        this.clankerContracts.clankerFactory.on('TokenCreated', 
            async (tokenAddress, positionId, deployer, fid, name, symbol, supply, castHash, event) => {
            try {
                this.lastEventTime = Date.now();
                const wethAddress = await this.clankerContracts.clankerFactory.weth();
                await handleClankerToken({
                    tokenAddress, positionId, deployer, fid, name, symbol, supply, castHash,
                    transactionHash: event.log.transactionHash, event: event.log,
                    provider: this.provider, discord: this.discord, wethAddress
                });
            } catch (error) {
                handleError(error, 'Clanker Factory Event Handler');
            }
        });

        // V4 LISTENER (Cantik)
        this.clankerContracts.clankerFactoryV4.on('TokenCreated',
            async (msgSender, tokenAddress, tokenAdmin, tokenImage, tokenName, tokenSymbol, tokenMetadata, tokenContext, startingTick, poolHook, poolId, pairedToken, locker, mevModule, extensionsSupply, extensions, event) => {
                try {
                    this.lastEventTime = Date.now();
                    console.log(` [V4] Token Baru Terdeteksi: ${tokenName} (${tokenSymbol})`);
                    const channel = await this.discord.channels.fetch(process.env.DISCORD_CLANKER_CHANNEL_ID);
                    
                    const embed = new EmbedBuilder()
                        .setColor(0xFF0000)
                        .setTitle(' CLANKER V4 ALERT')
                        .setDescription(`**${tokenName}** (${tokenSymbol})`)
                        .addFields(
                            { name: 'Token Address', value: `\`${tokenAddress}\``, inline: false },
                            { name: 'Creator', value: `\`${tokenAdmin}\``, inline: true },
                            { name: ' Links', value: `[Basescan](https://basescan.org/address/${tokenAddress})\n[DexScreener](https://dexscreener.com/base/${tokenAddress})`, inline: false }
                        )
                        .setTimestamp()
                        .setFooter({ text: 'Clanker V4 • Real-time Alert' });

                    await channel.send({ content: ` **CLANKER V4 NEW TOKEN**`, embeds: [embed] });
                    console.log(` [V4] Alert terkirim ke Discord: ${tokenName}`);
                } catch (error) {
                    console.error(' Error V4 Handler:', error.message);
                }
            }
        );
        logger.detail('Clanker Factory V4 Listener', '1');

        // Presale Listener
        this.clankerContracts.clankerPresale.on('PreSaleCreated',
            async (preSaleId, bpsAvailable, ethPerBps, endTime, deployer, fid, name, symbol, supply, castHash, event) => {
            try {
                this.lastEventTime = Date.now();
                await handlePresaleCreated({
                    preSaleId, bpsAvailable, ethPerBps, endTime, deployer, fid, name, symbol, supply, castHash,
                    event, provider: this.provider, discord: this.discord
                });
            } catch (error) {
                handleError(error, 'Presale Creation Handler');
            }
        });

        this.provider.on({
            address: this.clankerContracts.clankerPresale.target,
            topics: [ethers.id('buyIntoPreSale(uint256)')]
        }, async (log) => {
            try {
                this.lastEventTime = Date.now();
                const tx = await this.provider.getTransaction(log.transactionHash);
                const decodedData = this.clankerContracts.clankerPresale.interface.decodeFunctionData('buyIntoPreSale', tx.data);
                
                await handlePresalePurchase({
                    preSaleId: decodedData[0], buyer: tx.from, ethAmount: tx.value,
                    event: log, provider: this.provider, discord: this.discord
                });
            } catch (error) {
                handleError(error, 'Presale Purchase Handler');
            }
        });

        logger.detail('Clanker Factory Listeners', '1');
        logger.detail('Presale Contract Listeners', '1');
        logger.detail('Transaction Monitors', '1');
    }

    startHealthCheck() {
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = setInterval(async () => {
            if (this.isShuttingDown || this.isReconnecting) return;
            try {
                if (this.provider?.websocket?.readyState !== 1) {
                    logger.warn('WebSocket not ready, reconnecting...');
                    await this.handleDisconnect();
                }
            } catch (error) {
                logger.error(`Health check failed: ${error.message}`);
            }
        }, 30000);
    }

    async handleDisconnect() {
        if (this.isReconnecting || this.isShuttingDown) return;
        this.isReconnecting = true;
        this.reconnectAttempts++;
        logger.warn('Connection lost, attempting to reconnect...');
        
        try {
            await this.cleanup(false);
            this.isShuttingDown = false;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            await new Promise(resolve => setTimeout(resolve, delay));
            await this.initialize();
            this.isReconnecting = false;
            this.reconnectAttempts = 0;
        } catch (error) {
            this.isReconnecting = false;
            if (this.reconnectAttempts > 5) {
                await this.cleanup(true);
            } else {
                setTimeout(() => this.handleDisconnect(), 5000);
            }
        }
    }

    async cleanup(shouldExit = true) {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        
        try {
            ['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(signal => {
                process.removeAllListeners(signal);
            });
            process.removeAllListeners('unhandledRejection');
            
            if (this.clankerContracts?.clankerFactory) this.clankerContracts.clankerFactory.removeAllListeners();
            if (this.clankerContracts?.clankerPresale) this.clankerContracts.clankerPresale.removeAllListeners();
            
            if (this.provider) {
                this.provider.removeAllListeners();
                if (this.provider.websocket) {
                    this.provider.websocket.removeAllListeners();
                    this.provider.websocket.terminate();
                }
                try { await this.provider.destroy(); } catch (error) {}
                this.provider = null;
            }
            if (this.discord) {
                await this.discord.destroy();
                this.discord = null;
            }
            if (shouldExit) process.exit(0);
        } catch (error) {
            if (shouldExit) process.exit(1);
        }
    }

    startPingPong() {
        setInterval(() => {
            if (this.provider?.websocket?.readyState === 1) {
                this.provider.websocket.ping();
            }
        }, 30000);
        
        if (this.provider?.websocket) {
            this.provider.websocket.on('pong', () => {
                this.lastEventTime = Date.now();
            });
        }
    }
}

// === KODE ANTI-TIDUR UNTUK RAILWAY/RENDER ===
const port = process.env.PORT || 8080;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running!');
}).listen(port);

// Start the bot
new ClankerBot();