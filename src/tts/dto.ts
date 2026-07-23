import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ResolveChunkDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  voice_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  quality?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  gender?: string;

  @IsOptional()
  @IsIn(['openrouter', 'speechify'])
  provider?: 'openrouter' | 'speechify';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  model?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  voice?: string;

  @IsOptional()
  @IsIn(['backend', 'byok'])
  generation_source: 'backend' | 'byok' = 'backend';

  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsInt()
  @Min(1)
  chunker_version!: number;
}
