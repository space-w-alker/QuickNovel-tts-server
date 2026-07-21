import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';

export class ResolveChunkDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  model_id!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  voice_id!: string;

  @IsString()
  @IsNotEmpty()
  text!: string;

  @IsInt()
  @Min(1)
  chunker_version!: number;
}
