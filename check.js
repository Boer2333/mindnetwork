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
                    }
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
        const wallet = new ethers.Wallet(walletData.pk);
        
        try {
            console.log(`\n🔄 处理钱包: ${walletData.add}`);
            
            const signature = await this.createSignature(wallet);
            const response = await this.checkEligibilityWithRetry(requestManager, walletData.add, signature);
            
            if (response?.data) {
                const amount = this.formatTokenAmount(response.data.amount);
                console.log(`💰 可领取数量: ${amount} FHE`);
                
                // 保存结果
                this.results.push({
                    address: walletData.add,
                    amount: amount
                });
                
                // 只有当金额大于0时才累加
                if (response.data.amount && response.data.amount !== '0') {
                    this.totalAmount += BigInt(response.data.amount);
                }
                
                this.successCount++;
            } else {
                console.log('❌ 查询失败或无资格');
                this.results.push({
                    address: walletData.add,
                    amount: '0'
                });
                this.failCount++;
            }

        } catch (error) {
            console.error(`❌ 处理钱包 ${walletData.add} 失败:`, error.message || error);
            this.results.push({
                address: walletData.add,
                amount: '0'
            });
            this.failCount++;
        }
    }

    async saveResults() {
        try {
            const csvContent = ['address,amount\n'];
            this.results.forEach(result => {
                csvContent.push(`${result.address},${result.amount}\n`);
            });
            
            await writeFile('results.csv', csvContent.join(''), 'utf-8');
            console.log('📄 结果已保存到 results.csv');
        } catch (error) {
            console.error('❌ 保存结果失败:', error);
        }
    }

    async processWallets(concurrentLimit = 20) { // 默认并发数改为2
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