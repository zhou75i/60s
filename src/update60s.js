import puppeteer from 'puppeteer';
import { Octokit } from '@octokit/rest';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import deepEqual from 'fast-deep-equal';

dotenv.config();

// 初始化GitHub客户端
const octokit = new Octokit({ auth: process.env.GH_TOKEN });

// 核心配置
const CONFIG = {
    // GitHub仓库配置
    repo: {
        owner: process.env.REPO_OWNER,
        name: process.env.REPO_NAME,
        branch: process.env.BRANCH || 'main',
        imgPath: 'static/images/',
        jsonPath: 'static/60s/'
    },
    // API配置
    api: {
        url: 'https://60s.viki.moe/v2/60s',
        timeout: 10000 // API请求超时时间
    },
    // JSON处理配置
    json: {
        source: 'https://60s-static.viki.moe/',
        imageRepoPrefix: 'https://cdn.jsdmirror.com/gh/zhou75i/60s@main/static/images/'
    }
};

// 校验环境变量
if (!process.env.GH_TOKEN) {
    console.error('❌ 缺少环境变量：GH_TOKEN（GitHub访问令牌）');
    process.exit(1);
}

/**
 * 工具函数：获取北京时间的当日日期（YYYY-MM-DD）【核心修改】
 */
function getTodayDate() {
    const now = new Date();
    // 北京时间 = UTC + 8小时，转换为北京时间的Date对象
    const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    // 格式化为 YYYY-MM-DD
    return beijingTime.toISOString().split('T')[0];
}

/**
 * 工具函数：获取带北京时间的日志时间戳【核心修改】
 */
function getBeijingTimeStamp() {
    return new Date().toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai', // 强制使用上海时区（北京时间）
        hour12: false 
    });
}

/**
 * 步骤1：单次请求API并校验是否为当日更新数据（无循环，无数据则直接退出）
 */
async function fetchAndCheckApiData() {
    const today = getTodayDate();
    try {
        console.log(`[${getBeijingTimeStamp()}] 请求API获取当日(${today})数据...`);
        const response = await fetch(CONFIG.api.url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://60s.viki.moe/',
                'Cache-Control': 'no-cache'
            },
            timeout: CONFIG.api.timeout
        });

        if (!response.ok) throw new Error(`API请求失败：HTTP ${response.status}`);
        const apiRes = await response.json();
        const apiData = apiRes.data || {};

        // 校验1：API返回的date是否为北京时间的当日
        if (apiData.date !== today) {
            console.log(`[${getBeijingTimeStamp()}] ❌ API未返回当日(${today})数据，当前返回日期：${apiData.date || '无'}，退出本次执行`);
            process.exit(1); // 返回非0状态码，让Actions认为本次执行失败
        }

        // 校验2：核心字段完整性
        const requiredFields = ['date', 'news', 'tip', 'updated_at'];
        const missingFields = requiredFields.filter(field => !apiData[field]);
        if (missingFields.length > 0) {
            throw new Error(`当日数据缺失核心字段：${missingFields.join(', ')}`);
        }

        console.log(`[${getBeijingTimeStamp()}] ✅ 成功获取当日(${today})更新数据`);
        return apiData;

    } catch (err) {
        console.error(`[${getBeijingTimeStamp()}] API请求异常：${err.message}，退出本次执行`);
        process.exit(1);
    }
}

/**
 * 步骤2：处理API数据为目标JSON格式（删cover、改image、加source）
 */
function processJsonData(rawData) {
    const processed = { ...rawData };
    delete processed.cover; 
    processed.source = CONFIG.json.source; 
    
    // 替换image链接为自有仓库
    if (processed.date) {
        processed.image = `${CONFIG.json.imageRepoPrefix}${processed.date}.png`;
    }

    return processed;
}

/**
 * 步骤3：获取GitHub上已存在的当日JSON数据（如果有）
 */
async function getExistingJsonFile(date) {
    const jsonFilePath = `${CONFIG.repo.jsonPath}${date}.json`;
    try {
        const res = await octokit.rest.repos.getContent({
            owner: CONFIG.repo.owner,
            repo: CONFIG.repo.name,
            path: jsonFilePath,
            ref: CONFIG.repo.branch
        });

        // 解码Base64内容并解析为JSON
        const content = Buffer.from(res.data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (err) {
        // 404表示文件不存在，返回null
        if (err.status === 404) return null;
        throw new Error(`获取已有JSON失败：${err.message}`);
    }
}

/**
 * 步骤4：通用上传/写入函数（支持JSON/图片，防重复覆盖）
 */
async function uploadToGitHub(filePath, content, isJson = false) {
    try {
        // 检查文件是否存在
        const existingFile = await octokit.rest.repos.getContent({
            owner: CONFIG.repo.owner,
            repo: CONFIG.repo.name,
            path: filePath,
            ref: CONFIG.repo.branch
        }).catch(() => null);

        // 处理内容编码
        let contentBase64;
        if (Buffer.isBuffer(content)) {
            contentBase64 = content.toString('base64');
        } else {
            contentBase64 = Buffer.from(content, 'utf8').toString('base64');
        }

        // 上传/覆盖文件
        await octokit.rest.repos.createOrUpdateFileContents({
            owner: CONFIG.repo.owner,
            repo: CONFIG.repo.name,
            path: filePath,
            message: `Auto update 60s ${isJson ? 'JSON' : 'image'}: ${path.basename(filePath)}`,
            content: contentBase64,
            branch: CONFIG.repo.branch,
            sha: existingFile?.data?.sha // 存在则覆盖，不存在则新建
        });

        console.log(`✅ 成功${existingFile ? '覆盖' : '创建'}文件：${filePath}`);
    } catch (err) {
        throw new Error(`上传GitHub失败[${filePath}]：${err.message}`);
    }
}

/**
 * 步骤5：生成图片（复用原有逻辑）
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
            defaultViewport: { width: 1080, height: 6000, deviceScaleFactor: 2 },
            timeout: 60000
        });

        const page = await browser.newPage();
        // 捕获页面日志
        page.on('console', msg => console.log(`[页面${msg.type()}] ${msg.text()}`));
        page.on('pageerror', (err) => {
            console.error(`[页面错误] ${err.message}\n${err.stack}`);
            page.evaluate((msg) => window.IMAGE_ERROR = msg, err.message);
        });

        // 加载模板
        const templatePath = path.resolve(process.cwd(), 'src/template.html');
        await page.goto(`file://${templatePath}`, { waitUntil: 'domcontentloaded' });

        // 注入数据
        await page.evaluate((injectData) => {
            window.DATA = injectData;
            console.log('页面DATA注入成功，date=', injectData.date);
        }, data);

        await new Promise(resolve => setTimeout(resolve, 2000)); // 等待数据挂载

        // 触发绘制
        await page.evaluate(async () => {
            if (typeof generate !== 'function') throw new Error('未找到generate函数');
            await generate();
        });

        // 获取生成的Base64图片
        const imageBase64 = await page.waitForFunction(() => {
            if (window.IMAGE_ERROR) throw new Error(window.IMAGE_ERROR);
            return window.IMAGE_BASE64;
        }, { timeout: 180000, polling: 1000 });

        const canvasInfo = await page.evaluate(() => ({
            base64Length: window.IMAGE_BASE64?.length || 0,
            dataDate: window.DATA?.date || '无'
        }));
        console.log(`图片生成完成，Base64长度：${canvasInfo.base64Length}`);

        return imageBase64.jsonValue();
    } catch (err) {
        throw new Error(`图片生成失败：${err.message}`);
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * 主函数：核心业务流程
 */
async function main() {
    const today = getTodayDate();
    try {
        // 1. 单次请求API，无当日数据则直接退出（返回非0状态码）
        const apiData = await fetchAndCheckApiData();

        // 2. 处理JSON数据（删cover、改image、加source）
        const processedJson = processJsonData(apiData);

        // 3. 获取已有JSON并对比，避免重复覆盖
        const existingJson = await getExistingJsonFile(today);
        if (existingJson && deepEqual(processedJson, existingJson)) {
            console.log(`✅ 当日(${today})JSON数据无变化，跳过写入`);
        } else {
            // 4. 写入JSON文件到GitHub
            const jsonContent = JSON.stringify(processedJson, null, 2);
            const jsonFilePath = `${CONFIG.repo.jsonPath}${today}.json`;
            await uploadToGitHub(jsonFilePath, jsonContent, true);
        }

        // 5. 生成并上传图片（图片始终覆盖，因为绘制可能优化样式）
        const imageBase64 = await generateImage(apiData);
        const imageBuffer = Buffer.from(imageBase64.split(',')[1], 'base64');
        const imageFilePath = `${CONFIG.repo.imgPath}${today}.png`;
        await uploadToGitHub(imageFilePath, imageBuffer);

        console.log(`[${getBeijingTimeStamp()}] ✅ 当日(${today})任务全部完成`);
        process.exit(0);

    } catch (err) {
        console.error(`[${getBeijingTimeStamp()}] ❌ 任务执行失败：${err.message}`);
        process.exit(1);
    }
}

// 启动主流程
main();
