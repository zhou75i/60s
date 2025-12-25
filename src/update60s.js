import puppeteer from 'puppeteer';
import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// 初始化GitHub客户端
const octokit = new Octokit({ auth: process.env.GH_TOKEN });

// GitHub配置
const REPO_CONFIG = {
    owner: process.env.REPO_OWNER, 
    repo: process.env.REPO_NAME, 
    branch: process.env.BRANCH || 'main',
    imgPath: 'static/images/',
    jsonPath: 'static/60s/' // JSON文件存储路径
};

// API地址
const API_URL = 'https://60s.viki.moe/v2/60s';

// 自定义配置（JSON专用）
const JSON_CONFIG = {
    source: 'https://60s-static.viki.moe/', 
    imageRepoPrefix: 'https://cdn.jsdmirror.com/gh/zhou75i/60s@main/static/images/' 
};

// 校验环境变量
if (!process.env.GH_TOKEN || !REPO_CONFIG.owner || !REPO_CONFIG.repo) {
    console.error('缺少环境变量：GH_TOKEN/REPO_OWNER/REPO_NAME');
    process.exit(1);
}

// 入口函数
async function update60s() {
    async function fetch60sData() {
        let retries = 3;
        while (retries > 0) {
            try {
                const response = await fetch(API_URL, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Referer': 'https://60s.viki.moe/',
                        'Cache-Control': 'no-cache'
                    },
                    timeout: 10000
                });

                if (!response.ok) throw new Error(`API请求失败：${response.status}`);
                const apiData = await response.json();
                const cleanData = JSON.parse(JSON.stringify(apiData.data));
                
                const requiredFields = ['date', 'news', 'lunar_date', 'tip'];
                const missingFields = requiredFields.filter(field => !cleanData[field]);
                if (missingFields.length > 0) {
                    throw new Error(`API返回数据缺失核心字段：${missingFields.join(', ')}`);
                }
                if (!Array.isArray(cleanData.news)) {
                    throw new Error('API返回的news不是数组');
                }

                console.log(`✅ API数据校验完成：日期=${cleanData.date}，新闻数=${cleanData.news.length}`);
                return cleanData;
            } catch (err) {
                retries--;
                if (retries === 0) throw err;
                console.log(`API请求失败，重试(${3 - retries}/3)...`, err.message);
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }

    // 处理API数据为目标JSON格式
    function processJsonData(rawData) {
        // 1. 复制原始数据，排除cover字段
        const processedData = { ...rawData };
        delete processedData.cover; 
        
        // 2. 修改image链接
        if (processedData.image) {
            const date = processedData.date;
            processedData.image = `${JSON_CONFIG.imageRepoPrefix}${date}.png`;
        }
        
        // 3. 添加source字段
        processedData.source = JSON_CONFIG.source;

        return processedData;
    }

    try {
        // 1. 获取API数据
        const apiData = await fetch60sData();
        console.log(`成功获取${apiData.date}的60s数据，共${apiData.news.length}条新闻`);

        // 2. 处理JSON数据
        const jsonData = processJsonData(apiData);
        const jsonFileName = `${apiData.date}.json`;
        const jsonContent = JSON.stringify(jsonData, null, 2); // 格式化JSON，缩进2空格
        console.log(`✅ JSON数据处理完成`);

        // 3. 上传JSON文件到GitHub
        await uploadToGitHub(REPO_CONFIG.jsonPath + jsonFileName, jsonContent, 'utf8');
        console.log(`✅ 成功上传JSON文件到GitHub：${REPO_CONFIG.jsonPath}${jsonFileName}`);

        // 4. 生成图片
        const imageBase64 = await generateImage(apiData);
        const imageBuffer = Buffer.from(imageBase64.split(',')[1], 'base64');
        const imgFileName = `${apiData.date}.png`;

        // 5. 上传图片到GitHub（自动覆盖已有文件）
        await uploadToGitHub(REPO_CONFIG.imgPath + imgFileName, imageBuffer);
        console.log(`✅ 成功上传（覆盖）图片到GitHub：${REPO_CONFIG.imgPath}${imgFileName}`);

    } catch (err) {
        console.error('❌ 执行失败：', err.message);
        process.exit(1);
    }
}

/**
 * 通用上传函数（支持图片/JSON）
 * @param {string} filePath GitHub上的目标路径
 * @param {string|Buffer} content 要上传的内容（JSON字符串/图片Buffer）
 * @param {string} encoding 编码（JSON用utf8，图片用base64）
 */
async function uploadToGitHub(filePath, content, encoding = 'base64') {
    try {
        // 检查文件是否存在
        const existingFile = await octokit.rest.repos.getContent({
            owner: REPO_CONFIG.owner,
            repo: REPO_CONFIG.repo,
            path: filePath,
            ref: REPO_CONFIG.branch
        }).catch(() => null);

        // 处理内容编码
        let contentBase64;
        if (Buffer.isBuffer(content)) {
            contentBase64 = content.toString('base64');
        } else {
            contentBase64 = Buffer.from(content, encoding).toString('base64');
        }

        // 上传/覆盖文件
        await octokit.rest.repos.createOrUpdateFileContents({
            owner: REPO_CONFIG.owner,
            repo: REPO_CONFIG.repo,
            path: filePath,
            message: `Auto update 60s ${filePath.split('.').pop()} file: ${path.basename(filePath)}`,
            content: contentBase64,
            branch: REPO_CONFIG.branch,
            sha: existingFile?.data?.sha
        });
    } catch (err) {
        throw new Error(`上传GitHub失败[${filePath}]：${err.message}`);
    }
}

/**
 * 生成图片
 */
async function generateImage(data) {
    let browser;
    try {
        browser = await puppeteer.launch({
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--allow-file-access-from-files',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process'
            ],
            headless: 'new',
            defaultViewport: {
                width: 1080,
                height: 6000,
                deviceScaleFactor: 2
            },
            timeout: 60000
        });

        const page = await browser.newPage();

        // 捕获页面日志
        page.on('console', msg => {
            const type = msg.type();
            const text = msg.text();
            console.log(`[页面${type}] ${text}`);
        });
        page.on('pageerror', (err) => {
            console.error(`[页面错误] ${err.message}\n${err.stack}`);
            page.evaluate((errorMsg) => {
                window.IMAGE_ERROR = errorMsg;
            }, err.message);
        });

        // 加载模板
        const templatePath = path.resolve(process.cwd(), 'src/template.html');
        await page.goto(`file://${templatePath}`, { waitUntil: 'domcontentloaded' });

        // 校验注入数据
        if (!data || !data.date) {
            throw new Error('注入数据缺失date字段');
        }
        console.log('准备注入页面的核心数据：', {
            date: data.date,
            newsCount: data.news.length,
            lunar_date: data.lunar_date,
            tip: data.tip
        });

        // 注入数据到window.DATA
        await page.evaluate((injectData) => {
            try {
                window.DATA = injectData;
                console.log('页面window.DATA注入成功，date=', window.DATA.date);
                console.log('注入后window.DATA完整数据：', JSON.stringify(window.DATA, null, 2));
            } catch (err) {
                console.error('页面赋值window.DATA失败：', err.message);
                throw err;
            }
        }, data);

        // 等待数据挂载完成
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 触发绘制
        await page.evaluate(async () => {
            if (typeof generate === 'function') {
                await generate();
            } else {
                throw new Error('页面未找到generate函数');
            }
        });

        // 等待图片生成
        const imageBase64 = await page.waitForFunction(() => {
            if (window.IMAGE_ERROR) throw new Error(window.IMAGE_ERROR);
            return window.IMAGE_BASE64;
        }, { timeout: 180000, polling: 1000 });

        // 调试信息
        const canvasInfo = await page.evaluate(() => ({
            base64Length: window.IMAGE_BASE64?.length || 0,
            dataNewsLength: window.DATA?.news?.length || 0,
            dataDate: window.DATA?.date || '无'
        }));
        console.log(`图片生成完成，Base64长度：${canvasInfo.base64Length}，页面date：${canvasInfo.dataDate}`);

        return imageBase64.jsonValue();

    } catch (err) {
        throw new Error(`图片生成失败：${err.message}`);
    } finally {
        if (browser) await browser.close();
    }
}

// 执行入口
update60s();
