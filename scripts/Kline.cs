using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace GoldTracker
{
    public class SpotBar
    {
        public string Timestamp { get; set; }
        public string Minute { get; set; }

        public double Open { get; set; }
        public double High { get; set; }
        public double Low { get; set; }
        public double Close { get; set; }
        public double Volume { get; set; }
    }

    public static class FetchLatestSpot
    {
        private const int ImageWidth = 1400;
        private const int ImageHeight = 700;

        private static string RequireEnv(string name)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrWhiteSpace(value))
                throw new Exception($"Missing environment variable: {name}");
            return value;
        }

        private static string GetEnvOrDefault(string name, string fallback)
        {
            var value = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrWhiteSpace(value) ? fallback : value;
        }

        private static double ToNumber(JToken token)
        {
            if (!double.TryParse(token.ToString(), NumberStyles.Any, CultureInfo.InvariantCulture, out double value))
                throw new Exception($"Invalid numeric value: {token}");
            return value;
        }

        private static DateTime ParseUtcTime(string value)
        {
            return DateTime.ParseExact(
                value,
                "yyyy-MM-dd HH:mm:ss",
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
        }

        private static SpotBar NormalizeTwelveBar(JObject raw)
        {
            var timestamp = ParseUtcTime(raw["datetime"].ToString());
            var minute = new DateTime(timestamp.Year, timestamp.Month, timestamp.Day, timestamp.Hour, timestamp.Minute, 0, DateTimeKind.Utc);

            return new SpotBar
            {
                Timestamp = timestamp.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                Minute = minute.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                Open = ToNumber(raw["open"]),
                High = ToNumber(raw["high"]),
                Low = ToNumber(raw["low"]),
                Close = ToNumber(raw["close"]),
                Volume = 0
            };
        }

        private static async Task<List<SpotBar>> FetchYesterdaySpotBarsAsync()
        {
            string token = RequireEnv("TWELVE_TOKEN");
            string symbol = GetEnvOrDefault("TWELVE_SYMBOL", "XAU/USD");
            string interval = GetEnvOrDefault("TWELVE_INTERVAL", "1min");

            DateTime yesterday = DateTime.UtcNow.Date.AddDays(-1);
            string startDate = yesterday.ToString("yyyy-MM-dd") + " 00:00:00";
            string endDate = yesterday.ToString("yyyy-MM-dd") + " 23:59:59";

            string url = $"https://api.twelvedata.com/time_series?symbol={Uri.EscapeDataString(symbol)}&interval={Uri.EscapeDataString(interval)}&outputsize=1440&apikey={Uri.EscapeDataString(token)}&start_date={Uri.EscapeDataString(startDate)}&end_date={Uri.EscapeDataString(endDate)}";

            Console.WriteLine("Fetching data...");
            Console.WriteLine(url);

            using HttpClient client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("gold-tracker/1.0");

            string responseText = await client.GetStringAsync(url);
            JObject payload = JsonConvert.DeserializeObject<JObject>(responseText);

            if (payload?["status"]?.ToString() != "ok")
                throw new Exception($"TwelveData request failed:\n{responseText}");

            JArray values = payload["values"] as JArray;
            if (values == null || values.Count == 0)
                throw new Exception("No spot data returned.");

            var bars = values.Select(item => NormalizeTwelveBar(item as JObject)).OrderBy(b => b.Timestamp).ToList();
            return bars;
        }

        private static void EnsureDirectory(string filePath)
        {
            string dir = Path.GetDirectoryName(filePath);
            if (!Directory.Exists(dir))
                Directory.CreateDirectory(dir);
        }

        private static double PriceToY(double price, double minPrice, double maxPrice, double top, double height)
        {
            double span = maxPrice - minPrice;
            return span <= 0 ? top + height / 2.0 : top + height - ((price - minPrice) / span) * height;
        }

        private static void DrawSpotChart(List<SpotBar> bars, string outputPath)
        {
            EnsureDirectory(outputPath);

            using Bitmap bitmap = new Bitmap(ImageWidth, ImageHeight);
            using Graphics g = Graphics.FromImage(bitmap);
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;

            int padLeft = 100, padRight = 30, padTop = 60, padBottom = 80;
            int chartWidth = ImageWidth - padLeft - padRight;
            int chartHeight = ImageHeight - padTop - padBottom;

            g.Clear(Color.FromArgb(15, 23, 42));

            g.DrawString("Gold Spot XAU/USD", new Font("Arial", 22, FontStyle.Bold), Brushes.White, padLeft, 20);

            var prices = bars.SelectMany(b => new[] { b.High, b.Low }).ToList();
            double minPrice = prices.Min();
            double maxPrice = prices.Max();
            double padding = (maxPrice - minPrice) * 0.05;
            minPrice -= padding; maxPrice += padding;

            Pen gridPen = new Pen(Color.FromArgb(45, 55, 72));
            Font labelFont = new Font("Arial", 10);

            for (int i = 0; i <= 5; i++)
            {
                double y = padTop + chartHeight * i / 5.0;
                g.DrawLine(gridPen, padLeft, (float)y, ImageWidth - padRight, (float)y);
                double price = maxPrice - (maxPrice - minPrice) * i / 5.0;
                g.DrawString(price.ToString("F2"), labelFont, Brushes.White, 10, (float)y - 8);
            }

            double step = chartWidth / (double)Math.Max(bars.Count, 1);
            int candleWidth = Math.Max(2, (int)(step * 0.6));

            foreach (var (bar, i) in bars.Select((b, i) => (b, i)))
            {
                double x = padLeft + i * step + step / 2.0;
                double openY = PriceToY(bar.Open, minPrice, maxPrice, padTop, chartHeight);
                double closeY = PriceToY(bar.Close, minPrice, maxPrice, padTop, chartHeight);
                double highY = PriceToY(bar.High, minPrice, maxPrice, padTop, chartHeight);
                double lowY = PriceToY(bar.Low, minPrice, maxPrice, padTop, chartHeight);

                bool isBull = bar.Close >= bar.Open;
                Color bodyColor = isBull ? Color.LimeGreen : Color.Red;

                using Pen wickPen = new Pen(bodyColor);
                using Brush bodyBrush = new SolidBrush(bodyColor);

                g.DrawLine(wickPen, (float)x, (float)highY, (float)x, (float)lowY);

                float bodyTop = (float)Math.Min(openY, closeY);
                float bodyHeight = Math.Max(2f, (float)Math.Abs(closeY - openY));
                g.FillRectangle(bodyBrush, (float)(x - candleWidth / 2.0), bodyTop, candleWidth, bodyHeight);
            }

            bitmap.Save(outputPath, ImageFormat.Png);
            Console.WriteLine("Chart saved: " + outputPath);
        }

        public static async Task Main(string[] args)
        {
            try
            {
                var bars = await FetchYesterdaySpotBarsAsync();

                string csvPath = GetEnvOrDefault("YESTERDAY_SPOT_CSV_PATH", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "output", "yesterday-spot.csv"));
                EnsureDirectory(csvPath);

                var rows = new List<string> { "timestamp,minute,open,high,low,close,volume" };
                rows.AddRange(bars.Select(bar =>
                    string.Format(CultureInfo.InvariantCulture, "{0},{1},{2},{3},{4},{5},{6}",
                        bar.Timestamp, bar.Minute, bar.Open, bar.High, bar.Low, bar.Close, bar.Volume)));

                await File.WriteAllLinesAsync(csvPath, rows, Encoding.UTF8);
                Console.WriteLine("CSV saved: " + csvPath);

                string imagePath = GetEnvOrDefault("YESTERDAY_SPOT_PLOT_PATH", Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "output", "spot-chart.png"));
                DrawSpotChart(bars, imagePath);

                               Console.WriteLine();
                Console.WriteLine($"Bars: {bars.Count}");

                Console.WriteLine(
                    $"Close Range: {bars.Min(x => x.Close):F2} - {bars.Max(x => x.Close):F2}");

                Console.WriteLine();
                Console.WriteLine("DONE");
            }
            catch (Exception ex)
            {
                Console.WriteLine();
                Console.WriteLine("ERROR:");
                Console.WriteLine(ex);

                Environment.ExitCode = 1;
            }
        }
    }
}