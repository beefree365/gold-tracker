using System;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace GoldTracker.Messaging
{
    public class WeComMessenger
    {
        private static readonly HttpClient _httpClient = new HttpClient();
        private static readonly ILogger<WeComMessenger> _logger;

        // Enterprise Information
        private const string CORP_ID = "ww2da9ac01321ae49c";
        private const int ROOT_DEPT_ID = 1; // Root department, usually 1

        private static readonly Dictionary<int, string> SecretDict = new Dictionary<int, string>
        {
            { 1000002, "qEsLoMKFBTvTtbOuxgq-Y7jfDdcphLFXvViPu3CR9bU" },
            { 1000003, "f4FoHoSa5KVW4Y-FejKoWo4VipblexMtd-4jhx_jLX0" }
        };

        // Cache AccessToken
        private static string _accessToken = string.Empty;
        private static DateTime _tokenExpireTime = DateTime.MinValue;

        static WeComMessenger()
        {
            // Initialize logger (you can configure this based on your logging framework)
            var loggerFactory = LoggerFactory.Create(builder => builder.AddConsole());
            _logger = loggerFactory.CreateLogger<WeComMessenger>();
        }

        /// <summary>
        /// Get AccessToken with caching
        /// </summary>
        private static async Task<string?> GetAccessToken(int agentId)
        {
            var now = DateTime.UtcNow;
            if (!string.IsNullOrEmpty(_accessToken) && now < _tokenExpireTime)
                return _accessToken;

            if (!SecretDict.TryGetValue(agentId, out string? secret))
            {
                _logger.LogError("AgentId {AgentId} not found in secret dictionary", agentId);
                return null;
            }

            var url = $"https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={CORP_ID}&corpsecret={secret}";
            
            try
            {
                var response = await _httpClient.GetAsync(url);
                response.EnsureSuccessStatusCode();
                
                var content = await response.Content.ReadAsStringAsync();
                var jsonDoc = JsonDocument.Parse(content);
                var root = jsonDoc.RootElement;

                if (root.TryGetProperty("errcode", out var errCode) && errCode.GetInt32() == 0)
                {
                    _accessToken = root.GetProperty("access_token").GetString() ?? string.Empty;
                    var expiresIn = root.GetProperty("expires_in").GetInt32();
                    _tokenExpireTime = now.AddSeconds(expiresIn - 60); // Refresh 60 seconds early
                    return _accessToken;
                }
                else
                {
                    throw new Exception($"Failed to get access token: {content}");
                }
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to get AccessToken");
                return null;
            }
        }

        /// <summary>
        /// Format time according to specified format
        /// </summary>
        public static string FormatTime(DateTime? date = null, string format = "yyyy-MM-dd HH:mm:ss")
        {
            var dt = date ?? DateTime.Now;
            return dt.ToString(format);
        }

        /// <summary>
        /// Send text message
        /// </summary>
        private static async Task SendTextMessage(string userId, string content, int agentId)
        {
            var token = await GetAccessToken(agentId);
            if (string.IsNullOrEmpty(token))
                return;

            var url = $"https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}";
            
            var payload = new
            {
                touser = userId,
                msgtype = "text",
                agentid = agentId,
                text = new { content },
                safe = 0
            };

            try
            {
                var jsonContent = JsonSerializer.Serialize(payload);
                var httpContent = new StringContent(jsonContent, System.Text.Encoding.UTF8, "application/json");
                
                var response = await _httpClient.PostAsync(url, httpContent);
                response.EnsureSuccessStatusCode();
                
                var result = await response.Content.ReadAsStringAsync();
                _logger.LogInformation("Sent text message to {UserId}: {Result}", userId, result);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to send text message");
            }
        }

        /// <summary>
        /// Upload image and get media_id
        /// </summary>
        public static async Task<string?> UploadImage(string filePath, int agentId)
        {
            var token = await GetAccessToken(agentId);
            if (string.IsNullOrEmpty(token))
                return null;

            var url = $"https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token={token}&type=image";

            try
            {
                using var form = new MultipartFormDataContent();
                using var fileStream = File.OpenRead(filePath);
                var streamContent = new StreamContent(fileStream);
                streamContent.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("image/png");
                
                form.Add(streamContent, "media", Path.GetFileName(filePath));

                var response = await _httpClient.PostAsync(url, form);
                response.EnsureSuccessStatusCode();
                
                var content = await response.Content.ReadAsStringAsync();
                var jsonDoc = JsonDocument.Parse(content);
                
                if (jsonDoc.RootElement.TryGetProperty("media_id", out var mediaId))
                    return mediaId.GetString();
                
                throw new Exception($"Failed to upload image: {content}");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to upload image");
                return null;
            }
        }

        /// <summary>
        /// Send image message using media_id
        /// </summary>
        private static async Task SendImageMessage(string userId, int agentId, string mediaId)
        {
            var token = await GetAccessToken(agentId);
            if (string.IsNullOrEmpty(token))
                return;

            var url = $"https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}";
            
            var payload = new
            {
                touser = userId,
                msgtype = "image",
                agentid = agentId,
                image = new { media_id = mediaId }
            };

            try
            {
                var jsonContent = JsonSerializer.Serialize(payload);
                var httpContent = new StringContent(jsonContent, System.Text.Encoding.UTF8, "application/json");
                
                var response = await _httpClient.PostAsync(url, httpContent);
                response.EnsureSuccessStatusCode();
                
                var result = await response.Content.ReadAsStringAsync();
                _logger.LogInformation("Sent image message to {UserId}: {Result}", userId, result);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to send image message");
            }
        }

        /// <summary>
        /// Send image by file path
        /// </summary>
        public static async Task SendImg(string imgPath, int agentId)
        {
            const string userId = "YiJianPing";

            var mediaId = await UploadImage(imgPath, agentId);
            if (!string.IsNullOrEmpty(mediaId))
                await SendImageMessage(userId, agentId, mediaId);
        }

        /// <summary>
        /// Send text message
        /// </summary>
        public static async Task SendMsg(string msg, int agentId)
        {
            const string userId = "YiJianPing";

            await SendTextMessage(userId, msg, agentId);
        }
    }
}
