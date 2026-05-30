using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
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

    public class FetchLatestSpot
    {
        private static string RequireEnv(string name)
        {
            var value = Environment.GetEnvironmentVariable(name);
            if (string.IsNullOrEmpty(value))
            {
                throw new Exception("Missing environment variable: " + name);
            }
            return value;
        }

        private static string GetEnvOrDefault(string name, string fallback)
        {
            var value = Environment.GetEnvironmentVariable(name);
            return string.IsNullOrEmpty(value) ? fallback : value;
        }

        private static double ToNumber(object value)
        {
            double result;
            if (!double.TryParse(value.ToString(), out result))
            {
                throw new Exception("Invalid numeric value: " + value);
            }
            return result;
        }

        private static SpotBar NormalizeTwelveBar(JObject raw)
        {
            var datetime = raw["datetime"].ToString();
            var timestamp = DateTime.Parse(datetime.Replace(" ", "T") + "Z");
            
            var minute = new DateTime(
                timestamp.Year, 
                timestamp.Month, 
                timestamp.Day, 
                timestamp.Hour, 
                timestamp.Minute, 
                0, 
                DateTimeKind.Utc
            );

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

        private static List<SpotBar> FetchYesterdaySpotBars()
        {
            var token = RequireEnv("TWELVE_TOKEN");
            var symbol = GetEnvOrDefault("TWELVE_SYMBOL", "XAU/USD");
            var interval = GetEnvOrDefault("TWELVE_INTERVAL", "1min");

            // Calculate yesterday's date
            var now = DateTime.UtcNow;
            var yesterday = now.AddDays(-1);
            var dateStr = yesterday.ToString("yyyy-MM-dd");
            var startDate = dateStr + " 00:00:00";
            var endDate = dateStr + " 23:59:59";

            Console.WriteLine("Fetching yesterday spot data from TwelveData...");
            Console.WriteLine("  Symbol: " + symbol);
            Console.WriteLine("  Interval: " + interval);
            Console.WriteLine("  Date: " + dateStr + " (yesterday)");
            Console.WriteLine("  Range: " + startDate + " to " + endDate);

            var url = "https://api.twelvedata.com/time_series" +
                "?symbol=" + Uri.EscapeDataString(symbol) +
                "&interval=" + Uri.EscapeDataString(interval) +
                "&outputsize=1440" +
                "&apikey=" + Uri.EscapeDataString(token) +
                "&start_date=" + Uri.EscapeDataString(startDate) +
                "&end_date=" + Uri.EscapeDataString(endDate);

            var request = WebRequest.Create(url) as HttpWebRequest;
            request.UserAgent = "gold-tracker-spot-yesterday/1.0";
            request.Method = "GET";

            string responseText;
            using (var response = request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
            {
                responseText = reader.ReadToEnd();
            }

            var payload = JsonConvert.DeserializeObject<JObject>(responseText);

            if (payload == null || payload["status"].ToString() != "ok")
            {
                throw new Exception("Twelve Data request failed: " + responseText);
            }

            var values = payload["values"] as JArray;
            if (values == null || values.Count == 0)
            {
                throw new Exception("No spot data returned for yesterday");
            }

            var bars = new List<SpotBar>();
            foreach (JObject item in values)
            {
                bars.Add(NormalizeTwelveBar(item));
            }

            bars.Sort((a, b) => DateTime.Compare(
                DateTime.Parse(a.Timestamp),
                DateTime.Parse(b.Timestamp)
            ));

            Console.WriteLine("  Retrieved " + bars.Count + " bars");
            Console.WriteLine("  Time range: " + bars[0].Timestamp + " to " + bars[bars.Count - 1].Timestamp);

            return bars;
        }

        private static string FormatTimestamp(string value)
        {
            var date = DateTime.Parse(value);
            return date.ToString("yyyy-MM-dd HH:mm:ss") + " UTC";
        }

        private static double PriceToY(double price, double minPrice, double maxPrice, double top, double height)
        {
            var span = maxPrice - minPrice;
            if (span == 0)
            {
                return top + height / 2;
            }
            return top + height - ((price - minPrice) / span) * height;
        }

        private static void DrawSpotChart(List<SpotBar> spotBars, string outputPath)
        {
            var width = 1400;
            var height = 700;
            
            // Create bitmap (similar to canvas)
            var bitmap = new Bitmap(width, height);
            var g = Graphics.FromImage(bitmap);

            var padLeft = 96;
            var padRight = 24;
            var padTop = 46;
            var padBottom = 80;
            var chartHeight = height - padTop - padBottom;
            var chartWidth = width - padLeft - padRight;

            // Background
            g.FillRectangle(new SolidBrush(Color.FromArgb(15, 23, 42)), 0, 0, width, height);

            // Title
            g.DrawString("Gold Spot (XAU/USD) Yesterday Full-Day K-Line",
                new Font("Arial", 26, FontStyle.Bold),
                new SolidBrush(Color.FromArgb(248, 250, 252)),
                padLeft, 30);

            // Subtitle
            g.DrawString(spotBars.Count + " bars | " +
                FormatTimestamp(spotBars[0].Timestamp) + " -> " +
                FormatTimestamp(spotBars[spotBars.Count - 1].Timestamp),
                new Font("Arial", 14),
                new SolidBrush(Color.FromArgb(203, 213, 225)),
                padLeft, 62);

            // Calculate price range
            var allPrices = new List<double>();
            foreach (var bar in spotBars)
            {
                allPrices.Add(bar.Open);
                allPrices.Add(bar.High);
                allPrices.Add(bar.Low);
                allPrices.Add(bar.Close);
            }
            var minPrice = allPrices.Min();
            var maxPrice = allPrices.Max();
            var span = Math.Max(1, maxPrice - minPrice);
            var padding = span * 0.05;
            var plotMin = minPrice - padding;
            var plotMax = maxPrice + padding;

            // Draw grid lines
            for (var i = 0; i <= 5; i++)
            {
                var y = padTop + (chartHeight / 5.0) * i;
                g.DrawLine(new Pen(Color.FromArgb(51, 65, 85)), padLeft, y, width - padRight, y);
                
                var priceLabel = (plotMax - ((plotMax - plotMin) / 5.0) * i).ToString("F2");
                g.DrawString(priceLabel,
                    new Font("Arial", 13),
                    new SolidBrush(Color.FromArgb(203, 213, 225)),
                    12, (float)y + 4);
            }

            var candleWidth = Math.Max(2, (int)Math.Floor(chartWidth / (double)Math.Max(spotBars.Count, 1) * 0.55));

            // Draw candlesticks
            for (var i = 0; i < spotBars.Count; i++)
            {
                var bar = spotBars[i];
                var x = padLeft + i * (chartWidth / (double)Math.Max(spotBars.Count - 1, 1));
                var openY = PriceToY(bar.Open, plotMin, plotMax, padTop, chartHeight);
                var closeY = PriceToY(bar.Close, plotMin, plotMax, padTop, chartHeight);
                var highY = PriceToY(bar.High, plotMin, plotMax, padTop, chartHeight);
                var lowY = PriceToY(bar.Low, plotMin, plotMax, padTop, chartHeight);

                // Wick
                g.DrawLine(new Pen(Color.FromArgb(56, 189, 248)),
                    (float)x, (float)highY, (float)x, (float)lowY);

                // Body
                var bodyTop = Math.Min(openY, closeY);
                var bodyHeight = Math.Max(2, Math.Abs(closeY - openY));
                g.FillRectangle(new SolidBrush(Color.FromArgb(56, 189, 248)),
                    (float)(x - candleWidth / 2.0), (float)bodyTop,
                    candleWidth, (float)bodyHeight);

                // Time labels
                if (i % Math.Max(1, (int)Math.Floor(spotBars.Count / 10.0)) == 0)
                {
                    var timeStr = FormatTimestamp(bar.Timestamp).Substring(5, 11);
                    var format = new StringFormat { Alignment = StringAlignment.Center };
                    g.DrawString(timeStr,
                        new Font("Arial", 12),
                        new SolidBrush(Color.FromArgb(203, 213, 225)),
                        (float)x, height - 20, format);
                }
            }

            // Legend
            g.DrawString("Spot (XAU/USD)",
                new Font("Arial", 13),
                new SolidBrush(Color.FromArgb(203, 213, 225)),
                padLeft + 120, 100);
            g.FillRectangle(new SolidBrush(Color.FromArgb(56, 189, 248)),
                padLeft + 70, 88, 12, 12);

            // Save to file
            bitmap.Save(outputPath, ImageFormat.Png);
            bitmap.Dispose();
            g.Dispose();
        }

        public static void Main(string[] args)
        {
            try
            {
                // Step 1: Fetch yesterday spot data
                var spotBars = FetchYesterdaySpotBars();

                // Step 2: Save to CSV
                Console.WriteLine("\nSaving spot data to CSV...");
                var csvRows = new List<string>();
                csvRows.Add("timestamp,minute,open,high,low,close,volume");
                
                foreach (var bar in spotBars)
                {
                    csvRows.Add(string.Format("{0},{1},{2},{3},{4},{5},{6}",
                        bar.Timestamp, bar.Minute, bar.Open, bar.High, bar.Low, bar.Close, bar.Volume));
                }

                var csvPath = GetEnvOrDefault("YESTERDAY_SPOT_CSV_PATH", 
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "output", "csv", "yesterday-spot-data.csv"));
                File.WriteAllLines(csvPath, csvRows.ToArray(), Encoding.UTF8);
                Console.WriteLine("Saved to: " + csvPath);

                // Step 3: Draw chart (placeholder)
                Console.WriteLine("\nDrawing spot chart...");
                var outputPath = GetEnvOrDefault("YESTERDAY_SPOT_PLOT_PATH",
                    Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "output", "yesterday-spot-kline.png"));
                DrawSpotChart(spotBars, outputPath);

                // Summary
                Console.WriteLine("\n=== Summary ===");
                Console.WriteLine("Total bars: " + spotBars.Count);
                
                var closePrices = spotBars.Select(b => b.Close).ToList();
                Console.WriteLine("Price range: $" + closePrices.Min().ToString("F2") + 
                    " - $" + closePrices.Max().ToString("F2"));
                
                var firstTime = spotBars[0].Timestamp.Split('T')[1].Substring(0, 5);
                var lastTime = spotBars[spotBars.Count - 1].Timestamp.Split('T')[1].Substring(0, 5);
                Console.WriteLine("Time range: " + firstTime + " - " + lastTime + " UTC");
                Console.WriteLine("\n✓ Latest spot data processing complete!");
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Error: " + error.Message);
                Environment.ExitCode = 1;
            }
        }
    }
}
