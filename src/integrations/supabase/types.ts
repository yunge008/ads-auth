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
          passcode_hash?: string
          tab_permissions?: string[]
          updated_at?: string
        }
        Relationships: []
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
          shop_content_type?: string | null
          title?: string | null
          tt_account_authorization_type?: string | null
          tt_account_name?: string | null
          vid?: string
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
