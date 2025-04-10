import { parse } from 'csv-parse/sync';
import { readFile, writeFile } from 'fs/promises';
import { ethers } from 'ethers';
import { RequestManager } from '../http.js';

class MindAgent {
    constructor() {
        this.baseURL = 'https://event-api.mindnetwork.xyz';
        this.successCount = 0;
        this.failCount = 0;
        this.version = '0.1.0';
        this.results = [];
        this.totalAmount = 0n;
        this.maxRetries = 5; // 最大重试次数
        this.contractAddress = '0xbdDE97f2B7cd2Ed7D4F3BB7D88E674cd9164B787';
        this.provider = new ethers.JsonRpcProvider('');
    }

    // 新增：构建claim交易
    async buildClaimTx(wallet, amount, proof) {
        try {
            const contractABI = ['function claim(uint256 fullAmount, bytes32[] proof)'];
            const contract = new ethers.Contract(
                this.contractAddress,
                contractABI,
                wallet.connect(this.provider)
            );
    
            // 修正：强制每个 proof 元素补齐到 32 字节
            const formattedProof = proof.map(p => {
                // 移除可能的 "0x" 前缀
                const hexValue = p.startsWith('0x') ? p.slice(2) : p;
                // 补齐到 64 字符（32字节）
                const paddedHex = hexValue.padStart(64, '0');
                return `0x${paddedHex}`;
            });
    
            return contract.claim.populateTransaction(
                BigInt(amount),
                formattedProof
            );
        } catch (error) {
            console.error('构建交易失败:', error);
            throw error;
        }
    }

    // 新增：发送交易
    async sendTransaction(wallet, txData) {
        try {
            const txResponse = await wallet.sendTransaction({
                ...txData,
                gasLimit: 160000,
                gasPrice: ethers.parseUnits("1.02", "gwei"),
                type: 0
            });
            
            console.log(`⛽ 交易已发送，哈希: ${txResponse.hash}`);
            const receipt = await txResponse.wait();
            
            if (receipt.status === 1) {
                console.log('✅ 交易成功确认');
                return true;
            } else {
                console.log('❌ 交易失败');
                return false;
            }
        } catch (error) {
            console.error('发送交易失败:', error.shortMessage || error.message);
            throw error;
        }
    }

    // 格式化代币数量
    formatTokenAmount(amount) {
        if (!amount) return '0';
        try {
            const amountBN = BigInt(amount);
            return ethers.formatEther(amountBN);
        } catch (error) {
            console.error('格式化金额错误:', error);
            return '0';
        }
    }

    // 延迟函数
    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async loadWallets() {
        try {
            const content = await readFile('wallet.csv', 'utf-8');
            return parse(content, {
                columns: true,
                skip_empty_lines: true
            });
        } catch (error) {
            console.error('📄 加载钱包文件失败:', error);
            throw error;
        }
    }

    async createSignature(wallet) {
        try {
            const message = "Sign to check the amount of FHE this wallet is eligible to claim.";
            return await wallet.signMessage(message);
        } catch (error) {
            console.error('❌ 创建签名失败:', error);
            throw error;
        }
    }

    async checkEligibilityWithRetry(requestManager, address, signature) {
        let lastError;
        let retryCount = 0;

        while (retryCount < this.maxRetries) {
            try {
                const response = await requestManager.simpleRequest({
                    method: 'GET',
                    url: `${this.baseURL}/grant/check-eligibility`,
                    params: {
                        wallet: address,
                        signature: signature
                    },
                    headers: {
                        'authority': 'event-api.mindnetwork.xyz',
                        'origin': 'https://agent.mindnetwork.xyz',
                        'referer': 'https://agent.mindnetwork.xyz/',
                        'version': this.version
                    },
                    timeout: 15000
                });

                if (response.code === 0) {
                    return response;
                }

                throw new Error(`请求返回错误码: ${response.code}`);

            } catch (error) {
                lastError = error;
                retryCount++;

                // 处理429错误
                if (error.response?.status === 429) {
                    const waitTime = 5000 + (retryCount * 2000); // 递增等待时间
                    console.log(`⏳ 遇到频率限制，等待${waitTime/1000}秒后重试(${retryCount}/${this.maxRetries})`);
                    await this.delay(waitTime);
                    continue;
                }

                // 其他错误
                if (retryCount < this.maxRetries) {
                    console.log(`🔄 请求失败，${retryCount}秒后重试(${retryCount}/${this.maxRetries})`);
                    await this.delay(retryCount * 1000);
                    continue;
                }
            }
        }

        throw lastError;
    }

    async processWallet(walletData) {
        const requestManager = new RequestManager(walletData.proxy);
        const wallet = new ethers.Wallet(walletData.pk, this.provider);
        
        try {
            console.log(`\n🔄 处理钱包: ${walletData.add}`);
            
            // 1. 查询资格
            const signature = await this.createSignature(wallet);
            const response = await this.checkEligibilityWithRetry(requestManager, walletData.add, signature);
            
            if (!response?.data || !response.data.amount || response.data.amount === '0') {
                console.log('❌ 无资格领取');
                this.results.push({
                    address: walletData.add,
                    amount: '0',
                    status: 'no_eligibility'
                });
                this.failCount++;
                return;
            }

            // 2. 构建交易
            console.log('🛠️ 构建交易数据...');
            const txData = await this.buildClaimTx(
                wallet,
                response.data.amount,
                JSON.parse(response.data.proof)
            );

            // 3. 发送交易
            console.log('🚀 发送交易...');
            const success = await this.sendTransaction(wallet, txData);
            
            // 4. 记录结果
            const amountFormatted = this.formatTokenAmount(response.data.amount);
            this.results.push({
                address: walletData.add,
                amount: amountFormatted,
                status: success ? 'success' : 'failed'
            });

            success ? this.successCount++ : this.failCount++;
            this.totalAmount += BigInt(response.data.amount);

        } catch (error) {
            console.error(`❌ 处理失败: ${error.message}`);
            this.results.push({
                address: walletData.add,
                amount: '0',
                status: 'error'
            });
            this.failCount++;
        }
    }

    async saveResults() {
        try {
            const csvContent = ['address,amount,status\n'];
            this.results.forEach(result => {
                csvContent.push(`${result.address},${result.amount},${result.status}\n`);
            });
            
            await writeFile('claim_results.csv', csvContent.join(''), 'utf-8');
            console.log('📄 结果已保存到 claim_results.csv');
        } catch (error) {
            console.error('❌ 保存结果失败:', error);
        }
    }

    async processWallets(concurrentLimit = 2) { // 默认并发数改为2
        try {
            const wallets = await this.loadWallets();
            console.log(`📊 总计待处理钱包数: ${wallets.length}`);

            let currentIndex = 0;
            const runningTasks = new Set();

            const processOne = async () => {
                if (currentIndex >= wallets.length) return;
                
                const wallet = wallets[currentIndex++];
                try {
                    await this.processWallet(wallet);
                } catch (error) {
                    console.error(`❌ 处理出错:`, error);
                } finally {
                    runningTasks.delete(processOne);
                    
                    // 增加基础延迟
                    const delay = 3000 + Math.random() * 4000;
                    await this.delay(delay);
                    
                    if (currentIndex < wallets.length) {
                        const newTask = processOne();
                        runningTasks.add(newTask);
                        await newTask;
                    }
                }
            };

            // 启动初始并发任务
            for (let i = 0; i < Math.min(concurrentLimit, wallets.length); i++) {
                if (i > 0) {
                    await this.delay(2000);
                }
                const task = processOne();
                runningTasks.add(task);
            }

            // 等待所有任务完成
            await Promise.all([...runningTasks]);

            // 保存结果
            await this.saveResults();

            // 显示统计信息
            console.log('\n━━━━━━━━━━━━ 最终统计 ━━━━━━━━━━━━');
            console.log(`✅ 成功: ${this.successCount} 个钱包`);
            console.log(`❌ 失败: ${this.failCount} 个钱包`);
            console.log(`💰 总可领取数量: ${ethers.formatEther(this.totalAmount)} FHE`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

        } catch (error) {
            console.error('❌ 处理过程出错:', error);
            throw error;
        }
    }
}

// 执行程序
console.log('🎯 Mind Agent 资格检查程序启动');
const agent = new MindAgent();
agent.processWallets().catch(error => {
    console.error('❌ 程序执行失败:', error);
    process.exit(1);
});
