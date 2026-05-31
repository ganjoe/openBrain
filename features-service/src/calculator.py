import pandas as pd
import numpy as np
from typing import List
from config_parser import FeatureConfig, FeatureType

class TechnicalCalculator:
    def calculate_features(self, df: pd.DataFrame, configs: List[FeatureConfig]) -> pd.DataFrame:
        """Applies technical indicators to the dataframe based on provided configs."""
        if df.empty:
            return df
            
        # Work on a copy to avoid SettingWithCopyWarning
        df = df.copy()
        
        for config in configs:
            if config.feature_type == FeatureType.SMA:
                df = self._calc_sma(df, config)
            elif config.feature_type == FeatureType.EMA:
                df = self._calc_ema(df, config)
            elif config.feature_type == FeatureType.BOLLINGER_BAND:
                df = self._calc_bb(df, config)
            elif config.feature_type == FeatureType.STOCHASTIC:
                df = self._calc_stoch(df, config)
            elif config.feature_type == FeatureType.IBD_RS:
                df = self._calc_ibd_rs_raw(df, config)
            elif config.feature_type == FeatureType.DAILY_RANGE:
                df = self._calc_daily_range(df, config)
            elif config.feature_type == FeatureType.DOLLAR_VOLUME:
                df = self._calc_dollar_volume(df, config)
            else:
                # F-PRC-047: Other features are stubs
                df = self._calc_stubs(df, config)
        
        # Minervini Trend Score muss nach IBD_RS berechnet werden, da es das RS-Rating verwendet
        minervini_configs = [c for c in configs if c.feature_type == FeatureType.MINERVINI_TREND]
        for config in minervini_configs:
            df = self._calc_minervini_trend(df, config)
                
        return df
    
    def _get_ma_series(self, df: pd.DataFrame, column: str, window: int, ma_type: FeatureType) -> pd.Series:
        """Shared helper to calculate MA with prepending to handle early data."""
        if df.empty or window <= 0:
            return pd.Series(dtype=float)
            
        if window == 1:
            return df[column].reset_index(drop=True).bfill().fillna(0)
            
        # F-PRC-100: Prepend duplicated first row to handle early data / IPO
        first_row = df.iloc[[0]]
        prepended = pd.concat([first_row] * (window - 1), ignore_index=True)
        calc_df = pd.concat([prepended, df], ignore_index=True)
        
        if ma_type == FeatureType.EMA:
            ma_series = calc_df[column].ewm(span=window, adjust=False).mean()
        else:
            ma_series = calc_df[column].rolling(window=window).mean()
            
        # Slice back to original size and bfill/fillna(0) for safety
        result = ma_series.iloc[window-1:].reset_index(drop=True)
        return result.bfill().fillna(0)

    def _calc_sma(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        window = config.window or 10
        column = config.additional_params.get("column", "close")
        df[config.feature_id] = self._get_ma_series(df, column, window, FeatureType.SMA).values
        return df

    def _calc_ema(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        window = config.window or 10
        column = config.additional_params.get("column", "close")
        df[config.feature_id] = self._get_ma_series(df, column, window, FeatureType.EMA).values
        return df

    def _calc_daily_range(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        safe_close = np.where(df['close'] == 0, np.nan, df['close'])
        df[config.feature_id] = ((df['high'] - df['low']) / safe_close * 100)
        df[config.feature_id] = df[config.feature_id].fillna(0)
        return df

    def _calc_dollar_volume(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        df[config.feature_id] = df['close'] * df['volume']
        return df

    def _calc_bb(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        """Calculates Bollinger Bands (upper, lower, average, bandwidth)."""
        window = config.window or 20
        ma_type_str = config.additional_params.get("type", "SMA").upper()
        ma_type = FeatureType.EMA if ma_type_str == "EMA" else FeatureType.SMA
        
        # Average line (SMA or EMA)
        avg_line = self._get_ma_series(df, 'close', window, ma_type)
        
        # Prepend for std dev calculation consistency
        first_row = df.iloc[[0]]
        prepended = pd.concat([first_row] * (window - 1), ignore_index=True)
        calc_df = pd.concat([prepended, df], ignore_index=True)
        std_dev = calc_df['close'].rolling(window=window).std().iloc[window-1:].reset_index(drop=True).bfill().fillna(0)
        
        df[f"{config.feature_id}_avg"] = avg_line.values
        df[f"{config.feature_id}_upper"] = (avg_line + (std_dev * 2)).values
        df[f"{config.feature_id}_lower"] = (avg_line - (std_dev * 2)).values
        
        # Bandwidth: (Upper - Lower) / Average
        # F-FEA-040: Protection against division by zero (P=0)
        avg_vals = df[f"{config.feature_id}_avg"].values
        safe_avg = np.where(avg_vals == 0, np.nan, avg_vals)
        
        df[f"{config.feature_id}_bandwidth"] = ((df[f"{config.feature_id}_upper"].values - df[f"{config.feature_id}_lower"].values) / safe_avg)
        df[f"{config.feature_id}_bandwidth"] = df[f"{config.feature_id}_bandwidth"].fillna(0)
        
        return df

    def _calc_stoch(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        """Calculates Stochastic %K and %D."""
        window = config.window or 14
        smooth_conf = config.additional_params.get("d", {})
        smooth_window = smooth_conf.get("window", 3)
        smooth_type_str = smooth_conf.get("type", "SMA").upper()
        smooth_type = FeatureType.EMA if smooth_type_str == "EMA" else FeatureType.SMA
        
        # %K = (Current Close - Lowest Low) / (Highest High - Lowest Low) * 100
        low_min = df['low'].rolling(window=window, min_periods=1).min()
        high_max = df['high'].rolling(window=window, min_periods=1).max()
        
        k_series = 100 * (df['close'] - low_min) / (high_max - low_min)
        k_series = k_series.fillna(0)
        
        df[f"{config.feature_id}_k"] = k_series.values
        
        # %D = MA of %K
        k_df = pd.DataFrame({'val': k_series})
        df[f"{config.feature_id}_d"] = self._get_ma_series(k_df, 'val', smooth_window, smooth_type).values
        
        return df
        
    def _calc_stubs(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        return df

    def _calc_ibd_rs_raw(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        """
        Calculates the normalized weighted ROC score for IBD RS rating.
        
        Uses weighted normalization: only ROC components for which enough
        data exists are computed. The result is scaled to a full 5-weight
        basis (2+1+1+1) so that short-history tickers are not penalized
        by having missing components set to 0.
        
        Rows with < 63 data points get NaN (excluded from cross-sectional ranking).
        """
        n_rows = len(df)
        if n_rows < 1:
            df[f"{config.feature_id}_raw"] = np.nan
            return df

        close = df['close']
        
        # Define ROC periods and their IBD weights
        periods_weights = [(63, 2), (126, 1), (189, 1), (252, 1)]
        full_weight_sum = sum(w for _, w in periods_weights)  # = 5
        
        # Compute each ROC component, leave NaN where insufficient data
        roc_components = []
        for period, weight in periods_weights:
            roc = close.pct_change(periods=period) * 100
            # Replace inf (from P=0 division) with NaN — NOT 0
            roc = roc.replace([np.inf, -np.inf], np.nan)
            roc_components.append((roc, weight))
        
        # Build weighted sum row by row, normalizing by available weights
        raw_scores = pd.Series(np.nan, index=df.index, dtype=float)
        
        for i in range(n_rows):
            available_sum = 0.0
            available_weight = 0
            
            for roc, weight in roc_components:
                val = roc.iloc[i]
                if not np.isnan(val):
                    available_sum += val * weight
                    available_weight += weight
            
            if available_weight > 0:
                # Normalize to full weight basis (5) so scores are comparable
                raw_scores.iloc[i] = available_sum * (full_weight_sum / available_weight)
            # else: stays NaN → excluded from cross-sectional ranking
        
        df[f"{config.feature_id}_raw"] = raw_scores.values
        return df

    def _calc_breadth_minervini_raw(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        """
        Calculates the 7 Minervini conditions (without RS Rating) and saves a binary
        column if all 7 conditions are met. Used for aggregated market breadth.
        """
        if len(df) < 260:
            df[f"{config.feature_id}_raw"] = 0
            return df
            
        sma_50 = self._get_ma_series(df, 'close', 50, FeatureType.SMA).values
        sma_150 = self._get_ma_series(df, 'close', 150, FeatureType.SMA).values
        sma_200 = self._get_ma_series(df, 'close', 200, FeatureType.SMA).values
        
        sma_200_vor_20 = np.roll(sma_200, 20)
        sma_200_vor_20[:20] = sma_200[:1]
        
        first_row = df.iloc[[0]]
        prepended = pd.concat([first_row] * 259, ignore_index=True)
        calc_df_52w = pd.concat([prepended, df], ignore_index=True)
        
        high_52w = calc_df_52w['high'].rolling(window=260).max().iloc[259:].reset_index(drop=True).values
        low_52w = calc_df_52w['low'].rolling(window=260).min().iloc[259:].reset_index(drop=True).values
        
        aktueller_preis = df['close'].values
        score = np.zeros(len(df), dtype=int)
        
        score += ((aktueller_preis > sma_150) & (aktueller_preis > sma_200)).astype(int)
        score += (sma_150 > sma_200).astype(int)
        score += (sma_200 > sma_200_vor_20).astype(int)
        score += ((sma_50 > sma_150) & (sma_50 > sma_200)).astype(int)
        score += (aktueller_preis > sma_50).astype(int)
        score += (aktueller_preis >= (low_52w * 1.30)).astype(int)
        score += (aktueller_preis >= (high_52w * 0.75)).astype(int)
        
        # 1 if all 7 conditions are met, otherwise 0
        df[f"{config.feature_id}_raw"] = (score == 7).astype(int)
        return df

    def _calc_minervini_trend(self, df: pd.DataFrame, config: FeatureConfig) -> pd.DataFrame:
        """
        Berechnet den Minervini Trend Template Score basierend auf 8 Kriterien.
        
        Die 8 Bedingungen:
        1. Preis liegt über SMA_150 und SMA_200
        2. SMA_150 liegt über SMA_200
        3. SMA_200 tendiert seit mindestens einem Monat aufwärts (> vor 20 Tagen)
        4. SMA_50 liegt über SMA_150 und SMA_200
        5. Preis liegt über SMA_50
        6. Preis ist mindestens 30% höher als das 52-Wochen-Tief (260 Tage)
        7. Preis ist nicht weiter als 25% vom 52-Wochen-Hoch entfernt
        8. RS_Rating >= 70
        
        Verwendet das bereits berechnete ibd_rs_raw Rating für Bedingung 8.
        
        Returns: Score (0-8), Prozent_Score (0-100%), is_trend_template (bool)
        """
        if len(df) < 260:
            # Nicht genügend Daten für vollständige Berechnung
            df["minervini_score"] = pd.Series(0, index=df.index)
            df["minervini_percent"] = pd.Series(0.0, index=df.index)
            df["minervini_trend_template"] = pd.Series(False, index=df.index)
            return df
        
        # Gleitende Durchschnitte berechnen
        sma_50 = self._get_ma_series(df, 'close', 50, FeatureType.SMA).values
        sma_150 = self._get_ma_series(df, 'close', 150, FeatureType.SMA).values
        sma_200 = self._get_ma_series(df, 'close', 200, FeatureType.SMA).values
        
        # SMA_200 vor 20 Tagen (für Bedingung 3)
        sma_200_vor_20 = np.roll(sma_200, 20)
        sma_200_vor_20[:20] = sma_200[:1]  # Füllen mit erstem Wert für frühe Daten
        
        # Extreme der letzten 52 Wochen (260 Tage)
        # Prepend für korrekte Berechnung am Anfang
        first_row = df.iloc[[0]]
        prepended = pd.concat([first_row] * 259, ignore_index=True)
        calc_df_52w = pd.concat([prepended, df], ignore_index=True)
        
        high_52w = calc_df_52w['high'].rolling(window=260).max().iloc[259:].reset_index(drop=True).values
        low_52w = calc_df_52w['low'].rolling(window=260).min().iloc[259:].reset_index(drop=True).values
        
        # IBD RS Rating: Use the cross-sectional rank computed by processor.py
        # The column 'ibd_rs' (1-99 percentile) is injected back into the
        # _features.parquet by the batch pipeline. If not available (e.g. first
        # run or standalone calculation), condition 8 cannot be evaluated and
        # is treated as not met (conservative approach).
        if 'ibd_rs' in df.columns:
            rs_rating_ranked = df['ibd_rs'].fillna(0).values.astype(float)
        else:
            # No cross-sectional RS available → condition 8 = not met
            rs_rating_ranked = np.zeros(len(df), dtype=float)
        
        aktueller_preis = df['close'].values
        
        # Initialisiere Score-Arrays
        score = np.zeros(len(df), dtype=int)
        
        # Bedingung 1: Preis > SMA_150 UND Preis > SMA_200
        cond1 = (aktueller_preis > sma_150) & (aktueller_preis > sma_200)
        score += cond1.astype(int)
        
        # Bedingung 2: SMA_150 > SMA_200
        cond2 = sma_150 > sma_200
        score += cond2.astype(int)
        
        # Bedingung 3: SMA_200 > SMA_200_vor_20_Tagen (aufwärts tendierend)
        cond3 = sma_200 > sma_200_vor_20
        score += cond3.astype(int)
        
        # Bedingung 4: SMA_50 > SMA_150 UND SMA_50 > SMA_200
        cond4 = (sma_50 > sma_150) & (sma_50 > sma_200)
        score += cond4.astype(int)
        
        # Bedingung 5: Preis > SMA_50
        cond5 = aktueller_preis > sma_50
        score += cond5.astype(int)
        
        # Bedingung 6: Preis >= Tief_52Wochen * 1.30 (mindestens 30% höher als 52-Wochen-Tief)
        cond6 = aktueller_preis >= (low_52w * 1.30)
        score += cond6.astype(int)
        
        # Bedingung 7: Preis >= Hoch_52Wochen * 0.75 (nicht weiter als 25% vom Hoch entfernt)
        cond7 = aktueller_preis >= (high_52w * 0.75)
        score += cond7.astype(int)
        
        # Bedingung 8: RS_Rating >= 70
        cond8 = rs_rating_ranked >= 70
        score += cond8.astype(int)
        
        # Trend Template erfüllt wenn Score == 8
        is_trend_template = score == 8
        
        df["minervini_score"] = pd.Series(score, index=df.index)
        df["minervini_trend_template"] = pd.Series(is_trend_template, index=df.index)
        
        return df

    def compute_normalized_roc(self, close: pd.Series) -> tuple:
        """
        IBD-style weighted ROC score with normalization for a single ticker (latest row).
        Returns (normalized_score, num_components, data_length).
        """
        n = len(close)
        weighted_sum = 0.0
        used_weight = 0
        components_used = 0
        
        PERIODS_WEIGHTS = [(63, 2), (126, 1), (189, 1), (252, 1)]
        FULL_WEIGHT_SUM = 5

        for period, weight in PERIODS_WEIGHTS:
            if n > period:
                p_now = close.iloc[-1]
                p_then = close.iloc[-period - 1]
                if p_then != 0 and not np.isnan(p_then) and not np.isnan(p_now):
                    roc = ((p_now - p_then) / p_then) * 100
                    weighted_sum += roc * weight
                    used_weight += weight
                    components_used += 1

        if used_weight == 0:
            return 0.0, 0, n

        normalized = weighted_sum * (FULL_WEIGHT_SUM / used_weight)
        return round(normalized, 4), components_used, n

    def calculate_minervini_on_the_fly(self, df: pd.DataFrame, rs_rating: int | None = None) -> dict:
        """
        On-the-fly calculation of Minervini Trend Template conditions for the latest row.
        """
        if len(df) < 260:
            raise ValueError(f"Not enough data (need >= 260 rows, have {len(df)})")
            
        close = df["close"].values
        high = df["high"].values
        low = df["low"].values

        sma_50 = self._get_ma_series(df, "close", 50, FeatureType.SMA).values
        sma_150 = self._get_ma_series(df, "close", 150, FeatureType.SMA).values
        sma_200 = self._get_ma_series(df, "close", 200, FeatureType.SMA).values

        high_52w = pd.Series(high).rolling(window=260, min_periods=1).max().values
        low_52w = pd.Series(low).rolling(window=260, min_periods=1).min().values

        sma_200_20ago = np.roll(sma_200, 20)
        sma_200_20ago[:20] = sma_200[0]

        i = -1
        conditions = {
            "1_price_above_sma150_and_sma200": bool(close[i] > sma_150[i] and close[i] > sma_200[i]),
            "2_sma150_above_sma200": bool(sma_150[i] > sma_200[i]),
            "3_sma200_trending_up": bool(sma_200[i] > sma_200_20ago[i]),
            "4_sma50_above_sma150_and_sma200": bool(sma_50[i] > sma_150[i] and sma_50[i] > sma_200[i]),
            "5_price_above_sma50": bool(close[i] > sma_50[i]),
            "6_price_30pct_above_52w_low": bool(close[i] >= low_52w[i] * 1.30),
            "7_price_within_25pct_of_52w_high": bool(close[i] >= high_52w[i] * 0.75),
            "8_rs_rating_above_70": bool(rs_rating >= 70) if rs_rating is not None else None,
        }

        score = sum(1 for v in conditions.values() if v is True)
        max_score = 8 if rs_rating is not None else 7
        is_template = score == 8 and rs_rating is not None

        return {
            "score": score,
            "max_score": max_score,
            "is_trend_template": is_template,
            "conditions": conditions,
            "context": {
                "close": round(float(close[i]), 2),
                "sma_50": round(float(sma_50[i]), 2),
                "sma_150": round(float(sma_150[i]), 2),
                "sma_200": round(float(sma_200[i]), 2),
                "high_52w": round(float(high_52w[i]), 2),
                "low_52w": round(float(low_52w[i]), 2),
            },
        }
