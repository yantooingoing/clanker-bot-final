const { ethers } = require('ethers');
const addresses = require('../addresses.json');
const { validateAddresses } = require('../utils');
const logger = require('../../utils/logger');

class ClankerContractHelper {
    constructor(provider) {
        this.provider = provider;
        validateAddresses(addresses.clanker);
        
        // V3 (yang lama)
        this.clankerFactory = new ethers.Contract(
            addresses.clanker.factory,
            require('../abis/clanker/ClankerFactoryV3.json'),
            provider
        );
        logger.detail('Initialized Factory V3', addresses.clanker.factory);

        // 🔥 V4 BARU
        this.clankerFactoryV4 = new ethers.Contract(
            addresses.clanker.factoryV4,
            require('../abis/clanker/ClankerFactoryV4.json'),
            provider
        );
        logger.detail('Initialized Factory V4', addresses.clanker.factoryV4);

        this.clankerPresale = new ethers.Contract(
            addresses.clanker.presale,
            require('../abis/clanker/ClankerPreSale.json'),
            provider
        );
        logger.detail('Initialized Presale', addresses.clanker.presale);
    }

    getTokenContract(address) {
        return new ethers.Contract(
            address,
            require('../contracts/abis/token/Token.json'),
            this.provider
        );
    }
}

module.exports = ClankerContractHelper;