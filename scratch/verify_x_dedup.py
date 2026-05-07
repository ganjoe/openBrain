import os
import sys
from supabase import create_client, Client

SUPABASE_URL = os.environ.get("SUPABASE_URL", "http://localhost:8000")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

if not SUPABASE_KEY:
    print("Error: SUPABASE_SERVICE_ROLE_KEY is not set.")
    sys.exit(1)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

def verify_deduplication():
    print("Fetching X posts from agent_workspace...")
    
    # Fetch all x_post metadata
    response = supabase.table("agent_workspace").select("metadata").eq("artifact_type", "x_post").execute()
    
    data = response.data
    if not data:
        print("No X posts found in workspace.")
        return

    print(f"Total X posts found: {len(data)}")
    
    # Extract external_ids
    external_ids = []
    for row in data:
        meta = row.get("metadata", {})
        ext_id = meta.get("external_id")
        if ext_id:
            external_ids.append(ext_id)
            
    # Check for duplicates
    unique_ids = set(external_ids)
    
    duplicates = len(external_ids) - len(unique_ids)
    
    print("-" * 30)
    if duplicates == 0:
        print("✅ SUCCESS: No duplicates found! The until_id/deduplication logic is working perfectly.")
        print(f"Unique external_ids: {len(unique_ids)}")
    else:
        print(f"❌ WARNING: Found {duplicates} duplicate external_ids in the database.")
        
        # Find which ones are duplicated
        seen = set()
        dupes = set()
        for x in external_ids:
            if x in seen:
                dupes.add(x)
            else:
                seen.add(x)
        print("Duplicated IDs:", list(dupes)[:10], "..." if len(dupes) > 10 else "")

if __name__ == "__main__":
    verify_deduplication()
