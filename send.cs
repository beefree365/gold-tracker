
using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace NinjaTrader.NinjaScript.Indicators
{
    public class WeComHelper
    {
        // Enterprise Information
        private const String CORP_ID = "ww2da9ac01321ae49c";

        private const int ROOT_DEPT_ID = 1;

        // agentId -> secret
        private static readonly Dictionary<int, String> SecretDict =
            new Dictionary<int, String>
        {
            { 1000002, "qEsLoMKFBTvTtbOuxgq-Y7jfDdcphLFXvViPu3CR9bU" },
            { 1000003, "f4FoHoSa5KVW4Y-FejKoWo4VipblexMtd-4jhx_jLX0" }
        };

        // token cache
        private static readonly Dictionary<int, TokenInfo> TokenCache =
            new Dictionary<int, TokenInfo>();

        // lock per agent
        private static readonly Dictionary<int, SemaphoreSlim> TokenLocks =
            new Dictionary<int, SemaphoreSlim>();

        private static readonly HttpClient HttpClient =
            new HttpClient();

        public static event Action<string> OnPrint;

        public static void Print(string message)
        {
            if (OnPrint != null)
            {
                OnPrint(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + message);
            }
        }

        private class TokenInfo
        {
            public String AccessToken { get; set; }

            public DateTime ExpireTime { get; set; }
        }

        private static SemaphoreSlim GetLock(int agentId)
        {
            lock (TokenLocks)
            {
                if (!TokenLocks.ContainsKey(agentId))
                {
                    TokenLocks[agentId] =
                        new SemaphoreSlim(1, 1);
                }

                return TokenLocks[agentId];
            }
        }

        public static async Task<String> GetAccessTokenAsync(
            int agentId)
        {
            String secret;

            lock (SecretDict)
            {
                if (!SecretDict.TryGetValue(agentId, out secret))
                {
                    Print("AgentId not found: " + agentId);
                    return "";
                }
            }

            TokenInfo tokenInfo = null;

            lock (TokenCache)
            {
                if (TokenCache.ContainsKey(agentId))
                {
                    tokenInfo = TokenCache[agentId];
                }
            }

            if (tokenInfo != null
                && !String.IsNullOrWhiteSpace(tokenInfo.AccessToken)
                && DateTime.UtcNow < tokenInfo.ExpireTime)
            {
                return tokenInfo.AccessToken;
            }

            var tokenLock = GetLock(agentId);

            await tokenLock.WaitAsync();

            try
            {
                // double check
                lock (TokenCache)
                {
                    if (TokenCache.ContainsKey(agentId))
                    {
                        tokenInfo = TokenCache[agentId];
                    }
                }

                if (tokenInfo != null
                    && !String.IsNullOrWhiteSpace(tokenInfo.AccessToken)
                    && DateTime.UtcNow < tokenInfo.ExpireTime)
                {
                    return tokenInfo.AccessToken;
                }

                var url =
                    "https://qyapi.weixin.qq.com/cgi-bin/gettoken"
                    + "?corpid=" + Uri.EscapeDataString(CORP_ID)
                    + "&corpsecret=" + Uri.EscapeDataString(secret);

                var response =
                    await HttpClient.GetAsync(url);

                response.EnsureSuccessStatusCode();

                var content =
                    await response.Content.ReadAsStringAsync();

                Print("GetToken Response: " + content);

                var json = JObject.Parse(content);

                var errCode = (int)json["errcode"];

                if (errCode != 0)
                {
                    throw new Exception(content);
                }

                var accessToken =
                    json["access_token"].ToString();

                var expiresIn =
                    (int)json["expires_in"];

                tokenInfo = new TokenInfo
                {
                    AccessToken = accessToken,
                    ExpireTime =
                        DateTime.UtcNow.AddSeconds(expiresIn - 60)
                };

                lock (TokenCache)
                {
                    TokenCache[agentId] = tokenInfo;
                }

                return accessToken;
            }
            finally
            {
                tokenLock.Release();
            }
        }

        private static void ClearToken(int agentId)
        {
            lock (TokenCache)
            {
                if (TokenCache.ContainsKey(agentId))
                {
                    TokenCache.Remove(agentId);
                }
            }
        }

        public static async Task<bool> SendTextMessageAsync(
            String userId,
            String message,
            int agentId)
        {
            if (String.IsNullOrWhiteSpace(userId))
            {
                Print("userId empty");
                return false;
            }

            if (String.IsNullOrWhiteSpace(message))
            {
                Print("message empty");
                return false;
            }

            if (message.Length > 2000)
            {
                message = message.Substring(0, 2000);
            }

            return await SendTextMessageInternalAsync(
                userId,
                message,
                agentId,
                true);
        }

        private static async Task<bool> SendTextMessageInternalAsync(
            String userId,
            String message,
            int agentId,
            bool retry)
        {
            var token =
                await GetAccessTokenAsync(agentId);

            if (String.IsNullOrWhiteSpace(token))
            {
                return false;
            }

            var url =
                "https://qyapi.weixin.qq.com/cgi-bin/message/send"
                + "?access_token=" + token;

            var payload = new
            {
                touser = userId,
                msgtype = "text",
                agentid = agentId,
                text = new
                {
                    content = message
                },
                safe = 0
            };

            try
            {
                var json =
                    JsonConvert.SerializeObject(payload);

                var httpContent =
                    new StringContent(
                        json,
                        Encoding.UTF8,
                        "application/json");

                var response =
                    await HttpClient.PostAsync(
                        url,
                        httpContent);

                response.EnsureSuccessStatusCode();

                var result =
                    await response.Content.ReadAsStringAsync();

                Print("SendMessage Response: " + result);

                var jsonResult = JObject.Parse(result);

                var errCode =
                    (int)jsonResult["errcode"];

                if (errCode == 0)
                {
                    return true;
                }

                // token expired
                if ((errCode == 40014 || errCode == 42001)
                    && retry)
                {
                    Print("Token expired. Retry...");

                    ClearToken(agentId);

                    return await SendTextMessageInternalAsync(
                        userId,
                        message,
                        agentId,
                        false);
                }

                Print("SendMessage Failed: " + result);

                return false;
            }
            catch (Exception ex)
            {
                Print("SendTextMessageAsync Error: " + ex);

                return false;
            }
        }

        public static async Task<String> UploadImageAsync(
            String filePath,
            int agentId)
        {
            if (String.IsNullOrWhiteSpace(filePath))
            {
                Print("filePath empty");
                return "";
            }

            if (!File.Exists(filePath))
            {
                Print("File not found: " + filePath);
                return "";
            }

            var token =
                await GetAccessTokenAsync(agentId);

            if (String.IsNullOrWhiteSpace(token))
            {
                return "";
            }

            var url =
                "https://qyapi.weixin.qq.com/cgi-bin/media/upload"
                + "?access_token=" + token
                + "&type=image";

            try
            {
                using (var formData = new MultipartFormDataContent())
                {
                    var fileStream = new FileStream(
                        filePath,
                        FileMode.Open,
                        FileAccess.Read);

                    var streamContent = new StreamContent(fileStream);
                    streamContent.Headers.ContentType =
                        new MediaTypeHeaderValue("image/png");

                    formData.Add(
                        streamContent,
                        "media",
                        Path.GetFileName(filePath));

                    var response =
                        await HttpClient.PostAsync(url, formData);

                    response.EnsureSuccessStatusCode();

                    var result =
                        await response.Content.ReadAsStringAsync();

                    Print("UploadImage Response: " + result);

                    var jsonResult = JObject.Parse(result);

                    var errCode = (int)jsonResult["errcode"];

                    if (errCode == 0)
                    {
                        var mediaId =
                            jsonResult["media_id"].ToString();
                        return mediaId;
                    }

                    // token expired
                    if (errCode == 40014 || errCode == 42001)
                    {
                        Print("Token expired. Retrying upload...");

                        ClearToken(agentId);

                        token = await GetAccessTokenAsync(agentId);

                        if (String.IsNullOrWhiteSpace(token))
                        {
                            return "";
                        }

                        url =
                            "https://qyapi.weixin.qq.com/cgi-bin/media/upload"
                            + "?access_token=" + token
                            + "&type=image";

                        formData = new MultipartFormDataContent();
                        fileStream = new FileStream(
                            filePath,
                            FileMode.Open,
                            FileAccess.Read);

                        streamContent = new StreamContent(fileStream);
                        streamContent.Headers.ContentType =
                            new MediaTypeHeaderValue("image/png");

                        formData.Add(
                            streamContent,
                            "media",
                            Path.GetFileName(filePath));

                        response =
                            await HttpClient.PostAsync(url, formData);

                        response.EnsureSuccessStatusCode();

                        result =
                            await response.Content.ReadAsStringAsync();

                        jsonResult = JObject.Parse(result);

                        if ((int)jsonResult["errcode"] == 0)
                        {
                            return jsonResult["media_id"].ToString();
                        }
                    }

                    Print("UploadImage Failed: " + result);
                    return "";
                }
            }
            catch (Exception ex)
            {
                Print("UploadImageAsync Error: " + ex.Message);
                return "";
            }
        }

        public static async Task<bool> SendImageMessageAsync(
            String userId,
            int agentId,
            String mediaId)
        {
            if (String.IsNullOrWhiteSpace(userId))
            {
                Print("userId empty");
                return false;
            }

            if (String.IsNullOrWhiteSpace(mediaId))
            {
                Print("mediaId empty");
                return false;
            }

            return await SendImageMessageInternalAsync(
                userId,
                agentId,
                mediaId,
                true);
        }

        private static async Task<bool> SendImageMessageInternalAsync(
            String userId,
            int agentId,
            String mediaId,
            bool retry)
        {
            var token =
                await GetAccessTokenAsync(agentId);

            if (String.IsNullOrWhiteSpace(token))
            {
                return false;
            }

            var url =
                "https://qyapi.weixin.qq.com/cgi-bin/message/send"
                + "?access_token=" + token;

            var payload = new
            {
                touser = userId,
                msgtype = "image",
                agentid = agentId,
                image = new
                {
                    media_id = mediaId
                }
            };

            try
            {
                var json =
                    JsonConvert.SerializeObject(payload);

                var httpContent =
                    new StringContent(
                        json,
                        Encoding.UTF8,
                        "application/json");

                var response =
                    await HttpClient.PostAsync(
                        url,
                        httpContent);

                response.EnsureSuccessStatusCode();

                var result =
                    await response.Content.ReadAsStringAsync();

                Print("SendImageMessage Response: " + result);

                var jsonResult = JObject.Parse(result);

                var errCode =
                    (int)jsonResult["errcode"];

                if (errCode == 0)
                {
                    return true;
                }

                // token expired
                if ((errCode == 40014 || errCode == 42001)
                    && retry)
                {
                    Print("Token expired. Retry...");

                    ClearToken(agentId);

                    return await SendImageMessageInternalAsync(
                        userId,
                        agentId,
                        mediaId,
                        false);
                }

                Print("SendImageMessage Failed: " + result);

                return false;
            }
            catch (Exception ex)
            {
                Print("SendImageMessageAsync Error: " + ex.Message);

                return false;
            }
        }

        public static async Task<bool> SendImageFileAsync(
            String userId,
            String filePath,
            int agentId)
        {
            if (String.IsNullOrWhiteSpace(userId))
            {
                Print("userId empty");
                return false;
            }

            if (String.IsNullOrWhiteSpace(filePath))
            {
                Print("filePath empty");
                return false;
            }

            Print("Uploading image: " + filePath);

            var mediaId =
                await UploadImageAsync(filePath, agentId);

            if (String.IsNullOrWhiteSpace(mediaId))
            {
                Print("Upload image failed");
                return false;
            }

            Print("Image uploaded. MediaId: " + mediaId);

            return await SendImageMessageAsync(
                userId,
                agentId,
                mediaId);
        }
    }
}
