export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      ad_upload_rows: {
        Row: {
          attr_bucket: string | null
          attr_match_type: string | null
          attr_source: string | null
          attr_staff: string | null
          authorization_type: string | null
          campaign_id: string
          campaign_name: string | null
          clicks: number | null
          cost: number
          created_at: string
          creative_type: string
          currency: string | null
          gross_revenue: number
          id: string
          impressions: number | null
          orders: number
          posted_at: string | null
          product_id: string
          roi: number | null
          row_no: number
          status: string | null
          tt_account_name: string
          upload_id: string
          vid: string
          video_title: string | null
        }
        Insert: {
          attr_bucket?: string | null
          attr_match_type?: string | null
          attr_source?: string | null
          attr_staff?: string | null
          authorization_type?: string | null
          campaign_id?: string
          campaign_name?: string | null
          clicks?: number | null
          cost?: number
          created_at?: string
          creative_type?: string
          currency?: string | null
          gross_revenue?: number
          id?: string
          impressions?: number | null
          orders?: number
          posted_at?: string | null
          product_id?: string
          roi?: number | null
          row_no: number
          status?: string | null
          tt_account_name?: string
          upload_id: string
          vid?: string
          video_title?: string | null
        }
        Update: {
          attr_bucket?: string | null
          attr_match_type?: string | null
          attr_source?: string | null
          attr_staff?: string | null
          authorization_type?: string | null
          campaign_id?: string
          campaign_name?: string | null
          clicks?: number | null
          cost?: number
          created_at?: string
          creative_type?: string
          currency?: string | null
          gross_revenue?: number
          id?: string
          impressions?: number | null
          orders?: number
          posted_at?: string | null
          product_id?: string
          roi?: number | null
          row_no?: number
          status?: string | null
          tt_account_name?: string
          upload_id?: string
          vid?: string
          video_title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ad_upload_rows_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "ad_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      ad_uploads: {
        Row: {
          attributed_at: string | null
          country: string
          created_at: string
          file_name: string
          id: string
          month: string
          note: string | null
          period_end: string | null
          period_start: string | null
          row_count: number
          status: string
          total_cost: number
          total_revenue: number
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          attributed_at?: string | null
          country?: string
          created_at?: string
          file_name: string
          id?: string
          month?: string
          note?: string | null
          period_end?: string | null
          period_start?: string | null
          row_count?: number
          status?: string
          total_cost?: number
          total_revenue?: number
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          attributed_at?: string | null
          country?: string
          created_at?: string
          file_name?: string
          id?: string
          month?: string
          note?: string | null
          period_end?: string | null
          period_start?: string | null
          row_count?: number
          status?: string
          total_cost?: number
          total_revenue?: number
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      advertiser_countries: {
        Row: {
          advertiser_id: string
          advertiser_name: string | null
          country: string
          created_at: string
          shop_id: string | null
          shop_name: string | null
          updated_at: string
        }
        Insert: {
          advertiser_id: string
          advertiser_name?: string | null
          country: string
          created_at?: string
          shop_id?: string | null
          shop_name?: string | null
          updated_at?: string
        }
        Update: {
          advertiser_id?: string
          advertiser_name?: string | null
          country?: string
          created_at?: string
          shop_id?: string | null
          shop_name?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      app_accounts: {
        Row: {
          active: boolean
          created_at: string
          id: string
          is_admin: boolean
          name: string
          passcode: string | null
          passcode_hash: string
          tab_permissions: string[]
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          is_admin?: boolean
          name: string
          passcode?: string | null
          passcode_hash: string
          tab_permissions?: string[]
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          is_admin?: boolean
          name?: string
          passcode?: string | null
          passcode_hash?: string
          tab_permissions?: string[]
          updated_at?: string
        }
        Relationships: []
      }
      attribution_batch_details: {
        Row: {
          active_days: number
          attr_bucket: string
          attr_logic: string | null
          attr_role: string | null
          attr_staff: string | null
          batch_id: string
          cost_original: number
          cost_usd: number
          country: string
          created_at: string
          creative_type: string
          currency: string
          default_owner: string | null
          gmv_usd: number
          gross_revenue_original: number
          handover_applied: boolean
          id: string
          month: string
          note: string | null
          orders: number
          performance_counted: boolean
          posted_at: string | null
          posted_at_source: string | null
          target_group_id: string | null
          tt_account_name: string
          usd_rate: number
          vid: string
        }
        Insert: {
          active_days?: number
          attr_bucket: string
          attr_logic?: string | null
          attr_role?: string | null
          attr_staff?: string | null
          batch_id: string
          cost_original?: number
          cost_usd?: number
          country?: string
          created_at?: string
          creative_type?: string
          currency?: string
          default_owner?: string | null
          gmv_usd?: number
          gross_revenue_original?: number
          handover_applied?: boolean
          id?: string
          month: string
          note?: string | null
          orders?: number
          performance_counted?: boolean
          posted_at?: string | null
          posted_at_source?: string | null
          target_group_id?: string | null
          tt_account_name?: string
          usd_rate?: number
          vid?: string
        }
        Update: {
          active_days?: number
          attr_bucket?: string
          attr_logic?: string | null
          attr_role?: string | null
          attr_staff?: string | null
          batch_id?: string
          cost_original?: number
          cost_usd?: number
          country?: string
          created_at?: string
          creative_type?: string
          currency?: string
          default_owner?: string | null
          gmv_usd?: number
          gross_revenue_original?: number
          handover_applied?: boolean
          id?: string
          month?: string
          note?: string | null
          orders?: number
          performance_counted?: boolean
          posted_at?: string | null
          posted_at_source?: string | null
          target_group_id?: string | null
          tt_account_name?: string
          usd_rate?: number
          vid?: string
        }
        Relationships: [
          {
            foreignKeyName: "attribution_batch_details_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "attribution_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      attribution_batches: {
        Row: {
          completed_at: string | null
          config_snapshot: Json
          created_by: string | null
          failure_reason: string | null
          id: string
          month: string
          started_at: string
          status: string
          trigger_source: string
        }
        Insert: {
          completed_at?: string | null
          config_snapshot?: Json
          created_by?: string | null
          failure_reason?: string | null
          id?: string
          month: string
          started_at?: string
          status?: string
          trigger_source?: string
        }
        Update: {
          completed_at?: string | null
          config_snapshot?: Json
          created_by?: string | null
          failure_reason?: string | null
          id?: string
          month?: string
          started_at?: string
          status?: string
          trigger_source?: string
        }
        Relationships: []
      }
      attribution_review: {
        Row: {
          created_at: string
          default_resolution: string | null
          detail: Json | null
          first_seen_at: string
          id: string
          last_seen_at: string
          manual_bd: string | null
          manual_note: string | null
          review_key: string
          review_type: string
          status: string
          subject: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_resolution?: string | null
          detail?: Json | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          manual_bd?: string | null
          manual_note?: string | null
          review_key: string
          review_type: string
          status?: string
          subject: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_resolution?: string | null
          detail?: Json | null
          first_seen_at?: string
          id?: string
          last_seen_at?: string
          manual_bd?: string | null
          manual_note?: string | null
          review_key?: string
          review_type?: string
          status?: string
          subject?: string
          updated_at?: string
        }
        Relationships: []
      }
      attribution_run_state: {
        Row: {
          active_batch_id: string | null
          last_failure_at: string | null
          last_failure_reason: string | null
          last_success_at: string | null
          locked_until: string | null
          month: string
          updated_at: string
        }
        Insert: {
          active_batch_id?: string | null
          last_failure_at?: string | null
          last_failure_reason?: string | null
          last_success_at?: string | null
          locked_until?: string | null
          month: string
          updated_at?: string
        }
        Update: {
          active_batch_id?: string | null
          last_failure_at?: string | null
          last_failure_reason?: string | null
          last_success_at?: string | null
          locked_until?: string | null
          month?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "attribution_run_state_active_batch_id_fkey"
            columns: ["active_batch_id"]
            isOneToOne: false
            referencedRelation: "attribution_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      authorize_cron_state: {
        Row: {
          created_at: string
          errors: Json
          failed: number
          id: string
          last_run_at: string
          no_account: number
          note: string | null
          rounds: number
          success: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          errors?: Json
          failed?: number
          id: string
          last_run_at?: string
          no_account?: number
          note?: string | null
          rounds?: number
          success?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          errors?: Json
          failed?: number
          id?: string
          last_run_at?: string
          no_account?: number
          note?: string | null
          rounds?: number
          success?: number
          updated_at?: string
        }
        Relationships: []
      }
      authorize_log: {
        Row: {
          errors: Json
          failed: number
          id: number
          logged_at: string
          no_account: number
          note: string | null
          source: string
          success: number
        }
        Insert: {
          errors?: Json
          failed?: number
          id?: number
          logged_at?: string
          no_account?: number
          note?: string | null
          source?: string
          success?: number
        }
        Update: {
          errors?: Json
          failed?: number
          id?: number
          logged_at?: string
          no_account?: number
          note?: string | null
          source?: string
          success?: number
        }
        Relationships: []
      }
      creator_alias: {
        Row: {
          alias_display: string | null
          alias_norm: string
          bd_name: string
          country: string
          created_at: string
          decided_by: string | null
          evidence: Json | null
          evidence_vids: number
          id: string
          source: string
          updated_at: string
        }
        Insert: {
          alias_display?: string | null
          alias_norm: string
          bd_name: string
          country?: string
          created_at?: string
          decided_by?: string | null
          evidence?: Json | null
          evidence_vids?: number
          id?: string
          source: string
          updated_at?: string
        }
        Update: {
          alias_display?: string | null
          alias_norm?: string
          bd_name?: string
          country?: string
          created_at?: string
          decided_by?: string | null
          evidence?: Json | null
          evidence_vids?: number
          id?: string
          source?: string
          updated_at?: string
        }
        Relationships: []
      }
      creator_ownership: {
        Row: {
          country: string
          created_at: string
          display_name: string | null
          evidence: Json | null
          first_register_date: string | null
          id: string
          key_type: string
          match_key: string
          owner_bd: string
          owner_last_register_date: string | null
          resolved_at: string
          transfer_count: number
          updated_at: string
        }
        Insert: {
          country?: string
          created_at?: string
          display_name?: string | null
          evidence?: Json | null
          first_register_date?: string | null
          id?: string
          key_type: string
          match_key: string
          owner_bd: string
          owner_last_register_date?: string | null
          resolved_at?: string
          transfer_count?: number
          updated_at?: string
        }
        Update: {
          country?: string
          created_at?: string
          display_name?: string | null
          evidence?: Json | null
          first_register_date?: string | null
          id?: string
          key_type?: string
          match_key?: string
          owner_bd?: string
          owner_last_register_date?: string | null
          resolved_at?: string
          transfer_count?: number
          updated_at?: string
        }
        Relationships: []
      }
      creator_registry: {
        Row: {
          country: string
          created_at: string
          handle_norm: string
          handle_raw: string
          id: string
          nickname_norm: string
          nickname_raw: string
          register_date: string | null
          registered_sku: string | null
          role: string
          row_number: number | null
          sample_date: string | null
          source: string
          source_sheet: string
          staff_active: boolean
          staff_name: string
          updated_at: string
          vid: string
        }
        Insert: {
          country?: string
          created_at?: string
          handle_norm?: string
          handle_raw?: string
          id?: string
          nickname_norm?: string
          nickname_raw?: string
          register_date?: string | null
          registered_sku?: string | null
          role: string
          row_number?: number | null
          sample_date?: string | null
          source: string
          source_sheet: string
          staff_active?: boolean
          staff_name: string
          updated_at?: string
          vid?: string
        }
        Update: {
          country?: string
          created_at?: string
          handle_norm?: string
          handle_raw?: string
          id?: string
          nickname_norm?: string
          nickname_raw?: string
          register_date?: string | null
          registered_sku?: string | null
          role?: string
          row_number?: number | null
          sample_date?: string | null
          source?: string
          source_sheet?: string
          staff_active?: boolean
          staff_name?: string
          updated_at?: string
          vid?: string
        }
        Relationships: []
      }
      gmv_exchange_rates: {
        Row: {
          currency: string
          enabled: boolean
          updated_at: string
          updated_by: string | null
          usd_rate: number
        }
        Insert: {
          currency: string
          enabled?: boolean
          updated_at?: string
          updated_by?: string | null
          usd_rate: number
        }
        Update: {
          currency?: string
          enabled?: boolean
          updated_at?: string
          updated_by?: string | null
          usd_rate?: number
        }
        Relationships: []
      }
      gmv_max_sync_state: {
        Row: {
          id: string
          last_synced_at: string
          note: string | null
        }
        Insert: {
          id: string
          last_synced_at?: string
          note?: string | null
        }
        Update: {
          id?: string
          last_synced_at?: string
          note?: string | null
        }
        Relationships: []
      }
      gmv_max_vid_daily: {
        Row: {
          ad_video_view_rate_2s: number | null
          ad_video_view_rate_6s: number | null
          ad_video_view_rate_p100: number | null
          ad_video_view_rate_p25: number | null
          ad_video_view_rate_p50: number | null
          ad_video_view_rate_p75: number | null
          advertiser_id: string
          campaign_id: string
          campaign_name: string | null
          campaign_operation_status: string | null
          cost: number
          country: string
          created_at: string
          creative_delivery_status: string | null
          currency: string | null
          gross_revenue: number
          id: string
          item_group_id: string
          orders: number
          product_clicks: number
          product_impressions: number
          shop_content_type: string | null
          stat_date: string
          tt_account_authorization_type: string | null
          tt_account_name: string | null
          vid: string
        }
        Insert: {
          ad_video_view_rate_2s?: number | null
          ad_video_view_rate_6s?: number | null
          ad_video_view_rate_p100?: number | null
          ad_video_view_rate_p25?: number | null
          ad_video_view_rate_p50?: number | null
          ad_video_view_rate_p75?: number | null
          advertiser_id: string
          campaign_id?: string
          campaign_name?: string | null
          campaign_operation_status?: string | null
          cost?: number
          country?: string
          created_at?: string
          creative_delivery_status?: string | null
          currency?: string | null
          gross_revenue?: number
          id?: string
          item_group_id?: string
          orders?: number
          product_clicks?: number
          product_impressions?: number
          shop_content_type?: string | null
          stat_date: string
          tt_account_authorization_type?: string | null
          tt_account_name?: string | null
          vid?: string
        }
        Update: {
          ad_video_view_rate_2s?: number | null
          ad_video_view_rate_6s?: number | null
          ad_video_view_rate_p100?: number | null
          ad_video_view_rate_p25?: number | null
          ad_video_view_rate_p50?: number | null
          ad_video_view_rate_p75?: number | null
          advertiser_id?: string
          campaign_id?: string
          campaign_name?: string | null
          campaign_operation_status?: string | null
          cost?: number
          country?: string
          created_at?: string
          creative_delivery_status?: string | null
          currency?: string | null
          gross_revenue?: number
          id?: string
          item_group_id?: string
          orders?: number
          product_clicks?: number
          product_impressions?: number
          shop_content_type?: string | null
          stat_date?: string
          tt_account_authorization_type?: string | null
          tt_account_name?: string | null
          vid?: string
        }
        Relationships: []
      }
      gmv_max_vid_meta: {
        Row: {
          advertiser_id: string | null
          campaign_id: string | null
          created_at: string
          item_group_id: string | null
          posted_at: string | null
          shop_content_type: string | null
          title: string | null
          tt_account_authorization_type: string | null
          tt_account_name: string | null
          vid: string
        }
        Insert: {
          advertiser_id?: string | null
          campaign_id?: string | null
          created_at?: string
          item_group_id?: string | null
          posted_at?: string | null
          shop_content_type?: string | null
          title?: string | null
          tt_account_authorization_type?: string | null
          tt_account_name?: string | null
          vid: string
        }
        Update: {
          advertiser_id?: string | null
          campaign_id?: string | null
          created_at?: string
          item_group_id?: string | null
          posted_at?: string | null
          shop_content_type?: string | null
          title?: string | null
          tt_account_authorization_type?: string | null
          tt_account_name?: string | null
          vid?: string
        }
        Relationships: []
      }
      gmv_targets: {
        Row: {
          created_at: string
          id: string
          material_target: number
          month: string
          note: string | null
          role: string
          sites: string[]
          staff_name: string
          target_group_id: string
          target_usd: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          material_target?: number
          month: string
          note?: string | null
          role?: string
          sites?: string[]
          staff_name: string
          target_group_id: string
          target_usd?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          material_target?: number
          month?: string
          note?: string | null
          role?: string
          sites?: string[]
          staff_name?: string
          target_group_id?: string
          target_usd?: number
          updated_at?: string
        }
        Relationships: []
      }
      site_handovers: {
        Row: {
          country: string
          created_at: string
          from_bd: string
          handover_date: string
          id: string
          note: string | null
          to_bd: string
          updated_at: string
        }
        Insert: {
          country: string
          created_at?: string
          from_bd: string
          handover_date: string
          id?: string
          note?: string | null
          to_bd: string
          updated_at?: string
        }
        Update: {
          country?: string
          created_at?: string
          from_bd?: string
          handover_date?: string
          id?: string
          note?: string | null
          to_bd?: string
          updated_at?: string
        }
        Relationships: []
      }
      sku_product_map: {
        Row: {
          country: string
          created_at: string
          id: string
          merchant_sku: string
          product_id: string
          product_name: string | null
          sku_id: string | null
          updated_at: string
        }
        Insert: {
          country?: string
          created_at?: string
          id?: string
          merchant_sku?: string
          product_id: string
          product_name?: string | null
          sku_id?: string | null
          updated_at?: string
        }
        Update: {
          country?: string
          created_at?: string
          id?: string
          merchant_sku?: string
          product_id?: string
          product_name?: string | null
          sku_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      staff_sheets: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          role: string
          sheet_name: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          role?: string
          sheet_name: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          role?: string
          sheet_name?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      staff_vid_map: {
        Row: {
          country: string
          created_at: string
          id: string
          registered_sku: string | null
          source_sheet: string | null
          source_type: string
          staff_name: string
          updated_at: string
          vid: string
        }
        Insert: {
          country?: string
          created_at?: string
          id?: string
          registered_sku?: string | null
          source_sheet?: string | null
          source_type: string
          staff_name: string
          updated_at?: string
          vid: string
        }
        Update: {
          country?: string
          created_at?: string
          id?: string
          registered_sku?: string | null
          source_sheet?: string | null
          source_type?: string
          staff_name?: string
          updated_at?: string
          vid?: string
        }
        Relationships: []
      }
      tiktok_comment_sync_state: {
        Row: {
          advertiser_id: string
          last_run_at: string
          last_synced_until: string | null
          updated_at: string
        }
        Insert: {
          advertiser_id: string
          last_run_at?: string
          last_synced_until?: string | null
          updated_at?: string
        }
        Update: {
          advertiser_id?: string
          last_run_at?: string
          last_synced_until?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tiktok_comments: {
        Row: {
          advertiser_id: string
          avatar_url: string | null
          comment_create_time: string | null
          comment_id: string
          comment_type: string | null
          country: string | null
          created_at: string
          id: string
          like_count: number
          parent_comment_id: string | null
          pulled_at: string
          reply_count: number
          text: string | null
          text_zh: string | null
          updated_at: string
          username: string | null
          vid: string | null
        }
        Insert: {
          advertiser_id: string
          avatar_url?: string | null
          comment_create_time?: string | null
          comment_id: string
          comment_type?: string | null
          country?: string | null
          created_at?: string
          id?: string
          like_count?: number
          parent_comment_id?: string | null
          pulled_at?: string
          reply_count?: number
          text?: string | null
          text_zh?: string | null
          updated_at?: string
          username?: string | null
          vid?: string | null
        }
        Update: {
          advertiser_id?: string
          avatar_url?: string | null
          comment_create_time?: string | null
          comment_id?: string
          comment_type?: string | null
          country?: string | null
          created_at?: string
          id?: string
          like_count?: number
          parent_comment_id?: string | null
          pulled_at?: string
          reply_count?: number
          text?: string | null
          text_zh?: string | null
          updated_at?: string
          username?: string | null
          vid?: string | null
        }
        Relationships: []
      }
      tiktok_connections: {
        Row: {
          access_token: string
          advertiser_ids: string[]
          bc_id: string | null
          created_at: string
          expires_at: string | null
          id: string
          label: string
          updated_at: string
        }
        Insert: {
          access_token: string
          advertiser_ids?: string[]
          bc_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          label: string
          updated_at?: string
        }
        Update: {
          access_token?: string
          advertiser_ids?: string[]
          bc_id?: string | null
          created_at?: string
          expires_at?: string | null
          id?: string
          label?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_gmv_cron_secret: { Args: never; Returns: string }
      gmv_attr_monthly_agg: {
        Args: {
          _end: string
          _limit?: number
          _offset?: number
          _start: string
        }
        Returns: {
          active_days: number
          cost: number
          country: string
          currency: string
          gross_revenue: number
          orders: number
          posted_at: string
          shop_content_type: string
          tt_account_name: string
          vid: string
        }[]
      }
      verify_gmv_cron_key: { Args: { _key: string }; Returns: boolean }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
