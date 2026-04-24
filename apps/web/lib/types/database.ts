/**
 * Database type definitions matching the schema in supabase/migrations/.
 * These are hand-maintained until the Supabase CLI generates them from the live schema.
 * Run: `supabase gen types typescript --local > lib/types/database.ts` to regenerate.
 *
 * Each table entry requires Row, Insert, Update, and Relationships to satisfy
 * GenericTable from @supabase/supabase-js.
 */

export type SubscriptionTier = 'free' | 'pro' | 'elite';
export type GameStatus = 'scheduled' | 'live' | 'final' | 'postponed' | 'cancelled';
export type MarketType = 'moneyline' | 'run_line' | 'total' | 'prop' | 'parlay' | 'future';
export type PickResult = 'win' | 'loss' | 'push' | 'void' | 'pending';
export type BetOutcome = 'win' | 'loss' | 'push' | 'void';

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          email: string;
          subscription_tier: SubscriptionTier;
          age_verified: boolean;
          age_verified_at: string | null;
          date_of_birth: string | null;
          geo_state: string | null;
          geo_blocked: boolean;
          stripe_customer_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          email: string;
          subscription_tier?: SubscriptionTier;
          age_verified?: boolean;
          age_verified_at?: string | null;
          date_of_birth?: string | null;
          geo_state?: string | null;
          geo_blocked?: boolean;
          stripe_customer_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          email?: string;
          subscription_tier?: SubscriptionTier;
          age_verified?: boolean;
          age_verified_at?: string | null;
          date_of_birth?: string | null;
          geo_state?: string | null;
          geo_blocked?: boolean;
          stripe_customer_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      sportsbooks: {
        Row: {
          id: string;
          key: string;
          name: string;
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          key: string;
          name: string;
          active?: boolean;
          created_at?: string;
        };
        Update: {
          id?: string;
          key?: string;
          name?: string;
          active?: boolean;
          created_at?: string;
        };
        Relationships: [];
      };
      teams: {
        Row: {
          id: string;
          mlb_team_id: number;
          name: string;
          abbreviation: string;
          city: string;
          division: string;
          league: 'AL' | 'NL';
          venue_name: string | null;
          venue_city: string | null;
          venue_state: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          mlb_team_id: number;
          name: string;
          abbreviation: string;
          city: string;
          division: string;
          league: 'AL' | 'NL';
          venue_name?: string | null;
          venue_city?: string | null;
          venue_state?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          mlb_team_id?: number;
          name?: string;
          abbreviation?: string;
          city?: string;
          division?: string;
          league?: 'AL' | 'NL';
          venue_name?: string | null;
          venue_city?: string | null;
          venue_state?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      players: {
        Row: {
          id: string;
          mlb_player_id: number;
          full_name: string;
          position: string | null;
          bats: 'L' | 'R' | 'S' | null;
          throws: 'L' | 'R' | null;
          team_id: string | null;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          mlb_player_id: number;
          full_name: string;
          position?: string | null;
          bats?: 'L' | 'R' | 'S' | null;
          throws?: 'L' | 'R' | null;
          team_id?: string | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          mlb_player_id?: number;
          full_name?: string;
          position?: string | null;
          bats?: 'L' | 'R' | 'S' | null;
          throws?: 'L' | 'R' | null;
          team_id?: string | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'players_team_id_fkey';
            columns: ['team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      games: {
        Row: {
          id: string;
          mlb_game_id: number;
          game_date: string;
          game_time_utc: string | null;
          status: GameStatus;
          home_team_id: string;
          away_team_id: string;
          home_score: number | null;
          away_score: number | null;
          inning: number | null;
          venue_name: string | null;
          venue_state: string | null;
          weather_condition: string | null;
          weather_temp_f: number | null;
          weather_wind_mph: number | null;
          weather_wind_dir: string | null;
          probable_home_pitcher_id: string | null;
          probable_away_pitcher_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          mlb_game_id: number;
          game_date: string;
          game_time_utc?: string | null;
          status?: GameStatus;
          home_team_id: string;
          away_team_id: string;
          home_score?: number | null;
          away_score?: number | null;
          inning?: number | null;
          venue_name?: string | null;
          venue_state?: string | null;
          weather_condition?: string | null;
          weather_temp_f?: number | null;
          weather_wind_mph?: number | null;
          weather_wind_dir?: string | null;
          probable_home_pitcher_id?: string | null;
          probable_away_pitcher_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          mlb_game_id?: number;
          game_date?: string;
          game_time_utc?: string | null;
          status?: GameStatus;
          home_team_id?: string;
          away_team_id?: string;
          home_score?: number | null;
          away_score?: number | null;
          inning?: number | null;
          venue_name?: string | null;
          venue_state?: string | null;
          weather_condition?: string | null;
          weather_temp_f?: number | null;
          weather_wind_mph?: number | null;
          weather_wind_dir?: string | null;
          probable_home_pitcher_id?: string | null;
          probable_away_pitcher_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'games_home_team_id_fkey';
            columns: ['home_team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'games_away_team_id_fkey';
            columns: ['away_team_id'];
            isOneToOne: false;
            referencedRelation: 'teams';
            referencedColumns: ['id'];
          }
        ];
      };
      odds: {
        Row: {
          id: string;
          game_id: string;
          sportsbook_id: string;
          market: MarketType;
          home_price: number | null;
          away_price: number | null;
          total_line: number | null;
          over_price: number | null;
          under_price: number | null;
          prop_description: string | null;
          prop_line: number | null;
          prop_over_price: number | null;
          prop_under_price: number | null;
          run_line_spread: number | null;
          snapshotted_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          game_id: string;
          sportsbook_id: string;
          market: MarketType;
          home_price?: number | null;
          away_price?: number | null;
          total_line?: number | null;
          over_price?: number | null;
          under_price?: number | null;
          prop_description?: string | null;
          prop_line?: number | null;
          prop_over_price?: number | null;
          prop_under_price?: number | null;
          run_line_spread?: number | null;
          snapshotted_at?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          game_id?: string;
          sportsbook_id?: string;
          market?: MarketType;
          home_price?: number | null;
          away_price?: number | null;
          total_line?: number | null;
          over_price?: number | null;
          under_price?: number | null;
          prop_description?: string | null;
          prop_line?: number | null;
          prop_over_price?: number | null;
          prop_under_price?: number | null;
          run_line_spread?: number | null;
          snapshotted_at?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'odds_game_id_fkey';
            columns: ['game_id'];
            isOneToOne: false;
            referencedRelation: 'games';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'odds_sportsbook_id_fkey';
            columns: ['sportsbook_id'];
            isOneToOne: false;
            referencedRelation: 'sportsbooks';
            referencedColumns: ['id'];
          }
        ];
      };
      picks: {
        Row: {
          id: string;
          game_id: string;
          pick_date: string;
          market: MarketType;
          pick_side: string;
          model_probability: number;
          implied_probability: number | null;
          expected_value: number | null;
          confidence_tier: number;
          best_line_price: number | null;
          best_line_book_id: string | null;
          rationale_id: string | null;
          required_tier: SubscriptionTier;
          result: PickResult;
          generated_at: string;
          created_at: string;
          // migration 0010 — visibility gate
          visibility: 'shadow' | 'live';
          market_novig_prior: number | null;
          model_delta: number | null;
          news_signals_applied: boolean;
          news_signals_id: string | null;
          market_prior_id: string | null;
          // migration 0013 — SHAP feature attributions
          feature_attributions: Array<{
            feature_name: string;
            feature_value: number | string;
            shap_value: number;
            direction: 'positive' | 'negative';
            label: string;
          }> | null;
        };
        Insert: {
          id?: string;
          game_id: string;
          pick_date: string;
          market: MarketType;
          pick_side: string;
          model_probability: number;
          implied_probability?: number | null;
          expected_value?: number | null;
          confidence_tier: number;
          best_line_price?: number | null;
          best_line_book_id?: string | null;
          rationale_id?: string | null;
          required_tier?: SubscriptionTier;
          result?: PickResult;
          generated_at?: string;
          created_at?: string;
          visibility?: 'shadow' | 'live';
          market_novig_prior?: number | null;
          model_delta?: number | null;
          news_signals_applied?: boolean;
          news_signals_id?: string | null;
          market_prior_id?: string | null;
          feature_attributions?: Array<{
            feature_name: string;
            feature_value: number | string;
            shap_value: number;
            direction: 'positive' | 'negative';
            label: string;
          }> | null;
        };
        Update: {
          id?: string;
          game_id?: string;
          pick_date?: string;
          market?: MarketType;
          pick_side?: string;
          model_probability?: number;
          implied_probability?: number | null;
          expected_value?: number | null;
          confidence_tier?: number;
          best_line_price?: number | null;
          best_line_book_id?: string | null;
          rationale_id?: string | null;
          required_tier?: SubscriptionTier;
          result?: PickResult;
          generated_at?: string;
          created_at?: string;
          visibility?: 'shadow' | 'live';
          market_novig_prior?: number | null;
          model_delta?: number | null;
          news_signals_applied?: boolean;
          news_signals_id?: string | null;
          market_prior_id?: string | null;
          feature_attributions?: Array<{
            feature_name: string;
            feature_value: number | string;
            shap_value: number;
            direction: 'positive' | 'negative';
            label: string;
          }> | null;
        };
        Relationships: [
          {
            foreignKeyName: 'picks_game_id_fkey';
            columns: ['game_id'];
            isOneToOne: false;
            referencedRelation: 'games';
            referencedColumns: ['id'];
          }
        ];
      };
      rationale_cache: {
        Row: {
          id: string;
          pick_id: string | null;
          model_used: string;
          prompt_hash: string;
          rationale_text: string;
          tokens_used: number | null;
          cost_usd: number | null;
          generated_at: string;
        };
        Insert: {
          id?: string;
          pick_id?: string | null;
          model_used: string;
          prompt_hash: string;
          rationale_text: string;
          tokens_used?: number | null;
          cost_usd?: number | null;
          generated_at?: string;
        };
        Update: {
          id?: string;
          pick_id?: string | null;
          model_used?: string;
          prompt_hash?: string;
          rationale_text?: string;
          tokens_used?: number | null;
          cost_usd?: number | null;
          generated_at?: string;
        };
        Relationships: [];
      };
      pick_outcomes: {
        Row: {
          id: string;
          pick_id: string;
          game_id: string;
          result: PickResult;
          home_score: number;
          away_score: number;
          graded_at: string;
          notes: string | null;
        };
        Insert: {
          id?: string;
          pick_id: string;
          game_id: string;
          result: PickResult;
          home_score: number;
          away_score: number;
          graded_at?: string;
          notes?: string | null;
        };
        Update: {
          id?: string;
          pick_id?: string;
          game_id?: string;
          result?: PickResult;
          home_score?: number;
          away_score?: number;
          graded_at?: string;
          notes?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'pick_outcomes_pick_id_fkey';
            columns: ['pick_id'];
            isOneToOne: true;
            referencedRelation: 'picks';
            referencedColumns: ['id'];
          }
        ];
      };
      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          stripe_sub_id: string;
          stripe_price_id: string;
          tier: SubscriptionTier;
          status: string;
          current_period_start: string;
          current_period_end: string;
          cancel_at_period_end: boolean;
          canceled_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          stripe_sub_id: string;
          stripe_price_id: string;
          tier: SubscriptionTier;
          status: string;
          current_period_start: string;
          current_period_end: string;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          stripe_sub_id?: string;
          stripe_price_id?: string;
          tier?: SubscriptionTier;
          status?: string;
          current_period_start?: string;
          current_period_end?: string;
          cancel_at_period_end?: boolean;
          canceled_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'subscriptions_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: true;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          }
        ];
      };
      bankroll_entries: {
        Row: {
          id: string;
          user_id: string;
          pick_id: string | null;
          game_id: string | null;
          bet_date: string;
          market: MarketType | null;
          description: string | null;
          sportsbook_id: string | null;
          bet_amount_cents: number;
          odds_price: number;
          outcome: BetOutcome | null;
          profit_loss_cents: number | null;
          settled_at: string | null;
          notes: string | null;
          deleted_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          pick_id?: string | null;
          game_id?: string | null;
          bet_date: string;
          market?: MarketType | null;
          description?: string | null;
          sportsbook_id?: string | null;
          bet_amount_cents: number;
          odds_price: number;
          outcome?: BetOutcome | null;
          profit_loss_cents?: number | null;
          settled_at?: string | null;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string;
          pick_id?: string | null;
          game_id?: string | null;
          bet_date?: string;
          market?: MarketType | null;
          description?: string | null;
          sportsbook_id?: string | null;
          bet_amount_cents?: number;
          odds_price?: number;
          outcome?: BetOutcome | null;
          profit_loss_cents?: number | null;
          settled_at?: string | null;
          notes?: string | null;
          deleted_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'bankroll_entries_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'bankroll_entries_sportsbook_id_fkey';
            columns: ['sportsbook_id'];
            isOneToOne: false;
            referencedRelation: 'sportsbooks';
            referencedColumns: ['id'];
          }
        ];
      };
      geo_blocked_states: {
        Row: {
          state_code: string;
          reason: string | null;
          blocked_at: string;
        };
        Insert: {
          state_code: string;
          reason?: string | null;
          blocked_at?: string;
        };
        Update: {
          state_code?: string;
          reason?: string | null;
          blocked_at?: string;
        };
        Relationships: [];
      };
      age_gate_logs: {
        Row: {
          id: string;
          user_id: string | null;
          ip_hash: string | null;
          passed: boolean;
          method: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          ip_hash?: string | null;
          passed: boolean;
          method: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          user_id?: string | null;
          ip_hash?: string | null;
          passed?: boolean;
          method?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'age_gate_logs_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          }
        ];
      };
      cron_runs: {
        Row: {
          id: string;
          job_name: string;
          started_at: string;
          finished_at: string | null;
          status: 'running' | 'success' | 'failure';
          duration_ms: number | null;
          error_msg: string | null;
        };
        Insert: {
          id?: string;
          job_name: string;
          started_at?: string;
          finished_at?: string | null;
          status?: 'running' | 'success' | 'failure';
          duration_ms?: number | null;
          error_msg?: string | null;
        };
        Update: {
          id?: string;
          job_name?: string;
          started_at?: string;
          finished_at?: string | null;
          status?: 'running' | 'success' | 'failure';
          duration_ms?: number | null;
          error_msg?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      subscription_tier: SubscriptionTier;
      game_status: GameStatus;
      market_type: MarketType;
      pick_result: PickResult;
      bet_outcome: BetOutcome;
    };
  };
}
