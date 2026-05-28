// const axios = require('axios');
// const fs = require('fs');
// const FormData = require('form-data');

import axios from 'axios';
import fs from 'fs';
import FormData from 'form-data';


// 企业信息
const CORP_ID = 'ww2da9ac01321ae49c';
const ROOT_DEPT_ID = 1; // 根部门，一般是1

const secret_dict = {
    1000002: 'qEsLoMKFBTvTtbOuxgq-Y7jfDdcphLFXvViPu3CR9bU',
    1000003: 'f4FoHoSa5KVW4Y-FejKoWo4VipblexMtd-4jhx_jLX0',
}

// 缓存AccessToken
let accessToken = '';
let tokenExpireTime = 0;

// ---------------- 获取 AccessToken ----------------
async function getAccessToken(agentId) {
    const now = Date.now();
    if (accessToken && now < tokenExpireTime) return accessToken;
    
    let SECRET = secret_dict[agentId]

    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${SECRET}`;
    try {
        const res = await axios.get(url);
        if (res.data.errcode === 0) {
            accessToken = res.data.access_token;
            tokenExpireTime = now + (res.data.expires_in - 60) * 1000; // 提前60秒刷新
            return accessToken;
        } else {
            throw new Error(JSON.stringify(res.data));
        }
    } catch (err) {
        console.error('获取AccessToken失败:', err.response?.data || err.message);
        return null;
    }
}


// ---------------- 时间格式化 ----------------
export function formatTime(date = new Date(), format = "YYYY-MM-DD HH:mm:ss") {
    const pad = n => n.toString().padStart(2, "0");
    const map = {
        YYYY: date.getFullYear(),
        MM: pad(date.getMonth() + 1),
        DD: pad(date.getDate()),
        HH: pad(date.getHours()),
        mm: pad(date.getMinutes()),
        ss: pad(date.getSeconds()),
        SSS: date.getMilliseconds().toString().padStart(3, "0"),
    };
    return format.replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, k => map[k]);
}

// ---------------- 发送文本消息 ----------------
async function sendTextMessage(userId, content, agentId) {
    const token = await getAccessToken(agentId);
    if (!token) return;

    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
    const payload = { touser: userId, msgtype: 'text', agentid: agentId, text: { content }, safe: 0 };

    try {
        const res = await axios.post(url, payload);
        console.log(`发送文本消息给 ${userId}:`, res.data);
    } catch (err) {
        console.error('发送文本消息失败:', err.response?.data || err.message);
    }
}

// ---------------- 上传图片获取 media_id ----------------
export async function uploadImage(filePath, agentId) {
    const token = await getAccessToken(agentId);
    if (!token) return null;

    const form = new FormData();
    form.append("media", fs.createReadStream(filePath));

    const url = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=image`;

    try {
        const res = await axios.post(url, form, { headers: form.getHeaders() });
        if (res.data.media_id) return res.data.media_id;
        throw new Error(JSON.stringify(res.data));
    } catch (err) {
        console.error('上传图片失败:', err.response?.data || err.message);
        return null;
    }
}

// ---------------- 发送图片消息（media_id） ----------------
export async function sendImageMessage(userId, agentId, mediaId) {
    const token = await getAccessToken(agentId);
    if (!token) return;

    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
    const payload = { touser: userId, msgtype: 'image', agentid: agentId, image: { media_id: mediaId } };

    try {
        const res = await axios.post(url, payload);
        console.log(`发送图片消息给 ${userId}:`, res.data);
    } catch (err) {
        console.error('发送图片消息失败:', err.response?.data || err.message);
    }
}

export async function sendImg(img_path, agentId) {

    // const agentId = 1000003; // 企业应用AgentId
    const userid = 'YiJianPing'

    // await sendWeComMessage(userid, `这是第 1 条消息`, agentId);
    // await new Promise(res => setTimeout(res, ms)); // 等待1秒
    const mediaId = await uploadImage(img_path, agentId); // 本地图片路径
    if (mediaId) await sendImageMessage(userid, agentId, mediaId);
}

export async function sendMsg(msg, agentId) {

    // const agentId = 1000003; // 企业应用AgentId
    const userid = 'YiJianPing'

    await sendTextMessage(userid, msg, agentId)
}

